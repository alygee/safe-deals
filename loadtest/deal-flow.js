// Нагрузочный тест полного цикла сделки: 2 счёта → сделка → оплата → подтверждение (5 запросов на итерацию).
// Бьёт в haproxy в обход nginx: измеряем пропускную способность сервиса, а не защиту от флуда на входе.
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://haproxy:8000';
const RATE = Number(__ENV.RATE || 100); // итераций (сделок) в секунду

export const options = {
  scenarios: {
    deals: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '30s',
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:pay}': ['p(95)<200'],
    dropped_iterations: ['count<10'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

const post = (path, body, name, headers = {}) =>
  http.post(`${BASE}${path}`, body ? JSON.stringify(body) : null, {
    headers: { 'content-type': 'application/json', ...headers },
    tags: { name },
  });

export default function () {
  const buyer = post('/accounts', { balance: 100000 }, 'account').json('id');
  const seller = post('/accounts', { balance: 0 }, 'account').json('id');
  const deal = post('/deals', { buyerId: buyer, sellerId: seller, amount: 500 }, 'create').json('id');
  const pay = post(`/deals/${deal}/pay`, null, 'pay', { 'idempotency-key': `k6-${deal}` });
  const confirm = post(`/deals/${deal}/confirm`, null, 'confirm');

  // NestJS отвечает на POST кодом 201.
  check(pay, { 'paid': (r) => r.status === 201 && r.json('status') === 'paid' });
  check(confirm, { 'completed': (r) => r.status === 201 && r.json('status') === 'completed' });
}
