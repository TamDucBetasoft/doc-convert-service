// k6 load test for the async API.
//   k6 run -e BASE_URL=http://localhost:8080 -e API_KEY=... -e FILE=samples/generated/vi-multiscript.docx loadtest/convert.js
// Each virtual user uploads, polls, then downloads. Every iteration sends the same bytes, so start the
// gateway with CACHE_ENABLED=false to measure real conversion cost instead of cache hits.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const API_KEY = __ENV.API_KEY;
const FILE = __ENV.FILE || 'samples/generated/vi-multiscript.docx';
const source = open(`../${FILE}`, 'b');

const endToEnd = new Trend('convert_end_to_end_ms', true);

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: 5 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    convert_end_to_end_ms: ['p(95)<20000'],
  },
};

export default function () {
  const headers = { 'x-api-key': API_KEY, 'x-device-id': `k6-vu-${__VU}-xxxx` };
  const started = Date.now();

  const upload = http.post(
    `${BASE_URL}/v2/jobs`,
    { file: http.file(source, `load-${__VU}-${__ITER}.docx`) },
    { headers },
  );
  if (!check(upload, { 'accepted (200/202)': (r) => r.status === 200 || r.status === 202 })) {
    sleep(Number(upload.headers['Retry-After'] || 2));
    return;
  }

  const { jobId } = upload.json();
  let status = upload.json('status');
  for (let i = 0; i < 90 && status !== 'done' && status !== 'failed'; i++) {
    sleep(1);
    status = http.get(`${BASE_URL}/v2/jobs/${jobId}`, { headers }).json('status');
  }

  const result = http.get(`${BASE_URL}/v2/jobs/${jobId}/result`, { headers });
  check(result, { 'pdf returned': (r) => r.status === 200 });
  endToEnd.add(Date.now() - started);
  http.del(`${BASE_URL}/v2/jobs/${jobId}`, null, { headers });
}
