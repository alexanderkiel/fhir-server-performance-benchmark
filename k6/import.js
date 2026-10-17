import http from 'k6/http'
import { check } from 'k6'
import { Counter } from 'k6/metrics'
import { headers } from './util.js'

const bundleSize = new Counter('bundle_size')

export const options = {
  discardResponseBodies: true,
  // setup() loads the two seed bundles (~1.6k entries each) before the run.
  // On MS FHIR each takes ~30s, blowing past k6's default 60s setupTimeout; the
  // other servers finish well inside it. This is only a ceiling, so raising it
  // is harmless for the fast servers.
  setupTimeout: '600s',
  scenarios: {
    import: {
      executor: 'shared-iterations',
      vus: 20,
      iterations: 1000,
      maxDuration: '60m',
      gracefulStop: '30s',
    },
  },
}

export function setup() {

  const bundleUrl = __ENV.BUNDLE_URL
  const baseUrl = __ENV.BASE_URL
  const hdrs = headers()

  // MS FHIR processes transaction-bundle entries sequentially by default, which
  // serializes hundreds of SQL INSERTs per bundle. This header opts into parallel
  // entry processing — Microsoft's own throughput tuning guidance, not a
  // workaround (see fhir-best-practices). Scoped to microsoft so every server is
  // run with its own recommended config; other servers would just ignore it.
  if (__ENV.FHIRIMPL === 'microsoft') {
    hdrs['x-bundle-processing-logic'] = 'parallel'
  }

  // Per-request ceiling. Under the 20-VU import load MS FHIR's slow tail of large
  // transaction bundles can sit behind others and exceed the old 500s, getting
  // failed as client timeouts (~1.8% of imports). 900s gives that tail room to
  // finish; it's only a ceiling, so the faster servers are unaffected.
  const params = { headers: hdrs, timeout: '900s' }

  // Reset tgz's rotation cursor so every server starts from bundle #0 — each
  // FHIR impl then imports the exact same set of bundles in the same order.
  http.post(`${bundleUrl}/reset`, null)

  // Blaze can't resolve conditional references (samply/blaze#433): it stores
  // the bundles' `Practitioner?identifier=...` references verbatim, so its
  // imports would skip the lookups the other servers do and the reference
  // searches on Practitioner would come back empty. For it, collect the ids the
  // seed batches create and rewrite those references to literal ones before
  // posting, which Blaze then checks for referential integrity.
  const refs = __ENV.RESOLVE_CONDITIONAL_REFS === 'true' ? {} : null

  // First - load hospital and practitioner information
  const seeds = ["hospitalInformation.json", "practitionerInformation.json"]
  seeds.forEach(x => {
    const src = http.get(`${bundleUrl}/${x}`, {responseType: 'text'})
    const res = http.post(baseUrl, src.body, refs ? { ...params, responseType: 'text' } : params)
    if (refs) Object.assign(refs, literalRefs(JSON.parse(src.body), res.json()))
  })
  if (refs) console.log(`resolving ${Object.keys(refs).length} conditional references`)


  return { baseUrl, bundleUrl, params, refs, }
}

// Maps each conditional create of a seed batch ("Organization?identifier=...")
// to the literal reference of the resource it created ("Organization/<id>").
function literalRefs(bundle, response) {
  const refs = {}
  bundle.entry.forEach(({ request }, i) => {
    const location = response.entry[i].response.location
    if (!request.ifNoneExist || !location) return
    const id = location.split('/_history')[0].split('/').pop()
    refs[`${request.url}?${request.ifNoneExist}`] = `${request.url}/${id}`
  })
  return refs
}

const CONDITIONAL_REF = /"reference"\s*:\s*"([A-Za-z]+\?[^"]+)"/g

function resolveConditionalRefs(body, refs) {
  return body.replace(CONDITIONAL_REF, (match, ref) => refs[ref] ? `"reference":"${refs[ref]}"` : match)
}

export default function ({ baseUrl, bundleUrl, params, refs, }) {
  const bundle = http.get( bundleUrl, { tags: { group: '::source' }, responseType: 'text' })
  const body = refs ? resolveConditionalRefs(bundle.body, refs) : bundle.body
  const x = http.post( baseUrl, body, { ...params, tags: { group: '::import' } })

  if (!check(x, { ['Bundle import']: ({ status }) => status === 200 })) return
  bundleSize.add(JSON.parse(bundle.body).entry.length)
}
