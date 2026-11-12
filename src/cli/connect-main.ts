import { runConnect } from './connect';

runConnect(process.argv.slice(2), {
  http: (url, init) => fetch(url, init),
  now: Date.now,
  presentAuthorizeUrl: (url) => console.log(`\n${url}\n`),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  cwd: process.cwd(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error('예상하지 못한 오류로 중단했습니다. 연결 파일은 만들지 않았습니다.');
    process.exitCode = 1;
  },
);
