// node-fetch(v2)는 HTTPS_PROXY/HTTP_PROXY 환경변수를 자동으로 타지 않는다.
// 클라우드 개발 세션처럼 아웃바운드가 프록시를 통해서만 나가는 환경에서는 이게 없으면
// fetch가 DNS 조회 단계(getaddrinfo ENOTFOUND)에서 바로 죽는다.
// 프로덕션(Railway 등)에는 이 환경변수가 없으므로 agent 없이 평범한 node-fetch로 동작한다.
const nodeFetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyUrl =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy;

const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

function fetch(url, opts = {}) {
  if (proxyAgent && !opts.agent) {
    return nodeFetch(url, { ...opts, agent: proxyAgent });
  }
  return nodeFetch(url, opts);
}

module.exports = fetch;
