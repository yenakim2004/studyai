# 공개 데모

누구나 브라우저에서 10초 안에 써 볼 수 있는 학습 앱 사본입니다. 설치, 계정, AI가 없습니다. GitHub Pages가 `https://yenakim2004.github.io/studyai/`에서 내줄 수 있는 정적 사이트(HTML, 스크립트, 글꼴)이며, 이 문서는 데모를 어떻게 만들고 게시하는지, 무엇을 할 수 없는지 설명합니다.

## 방문자가 보는 것

* 모든 페이지의 배너: 예시 내용은 가상이고, 방문자가 넣은 것은 브라우저에만 남아 어디에도 올라가지 않으며, 데모에서는 AI 기능을 쓸 수 없다고 알립니다.
* **예시 과목 불러오기**: 한 번 누르면 가상 과목 하나(강의 둘, 슬라이드 7장씩, 플래시카드 13장, 모의시험 문제 8개, 노트 둘)가 생깁니다. 슬라이드를 읽어 낸 글과 나란히 보고, 검색하고, 플래시카드를 복습하고(출처 확인 포함), 모의시험을 만들어 풀 수 있습니다. 다시 누르면 두 번째 사본을 만들지 않고 그 과목을 엽니다.
* 그 밖의 기능은 어디서나처럼 동작합니다. 방문자는 자기 `.pptx`나 PDF 파일도 넣을 수 있고, 파일은 방문자의 기기에서 읽힙니다.
* AI 화면은 있지만 쓸 수 없다고 말합니다. 튜터, 생성 대화상자, 설정 → AI가 모두 이 사본에는 AI가 없다고 안내하고 아무것도 보낼 수 없습니다. 데모에는 보낼 수 있는 코드가 없기 때문입니다(아래 참조).

내용은 모두 가상입니다. 주제, 단위, 숫자, "규칙"이 지어낸 것이고 실제 과목, 사람, 기관은 나오지 않습니다.

## 만드는 법

```bash
pnpm build:demo       # 타입 검사 후 dist-demo/에 사이트를 씀
pnpm preview:demo     # http://localhost:4173/studyai/ 에서 확인
```

`build:demo`는 `vite build --mode demo`입니다. 이 모드는 `vite.config.ts`에서만, 정확히 다음을 바꿉니다.

| 항목 | 일반 빌드 (`pnpm build`) | 데모 빌드 (`pnpm build:demo`) |
|---|---|---|
| 내주는 곳 | Worker의 루트 | 하위 경로 `/studyai/` (다른 경로는 `STUDYAI_DEMO_BASE=/name/`. 라우터, 스크립트, 글꼴, 파일 읽기 Worker가 따라감) |
| 출력 폴더 | `dist/` | `dist-demo/` |
| AI 클라이언트 (`src/app/ai.ts`) | 로컬 서버와 통신하는 진짜 클라이언트 | `fetch`가 없고 항상 "쓸 수 없음"이라고 답하는 `src/app/ai.demo.ts`로 바뀜. 진짜 클라이언트는 번들에 없음 |
| 보안 헤더 | `dist/_headers` (CSP, nosniff, 프레임·리퍼러 규칙 등) | 없음. GitHub Pages는 헤더를 보낼 수 없으므로 정책이 페이지 안에 있음(다음 절) |
| 배너와 예시 과목 | 넣지 않음 | 넣음 (예시 과목은 누를 때 별도 조각으로 불러옴) |
| `404.html` | 없음 | 페이지 사본. `/studyai/course/…` 같은 주소에서 새로 고쳐도 앱이 열림 |

예시 과목(`src/demo/`)은 버튼을 누를 때 만듭니다. 테스트가 쓰는 합성 생성기(`tests/fixtures/pptx-builder.ts`)로 PowerPoint 파일 두 개를 메모리에서 만들고, 방문자 파일을 읽는 것과 같은 Worker 안의 진짜 엔진이 읽어 저장합니다. 플래시카드, 문제, 노트는 일반 학습 자료 묶음 가져오기를 거치므로 모든 인용을 슬라이드에서 찾습니다. 데모는 이것들을 미리 승인해 둡니다. 실제 앱에서는 가져온 자료가 학생의 승인을 기다리며, 이것이 의도한 유일한 차이입니다. 방문자가 플래시카드 하나를 보려고 21개 항목을 승인하지 않아도 되게 하려는 것입니다.

## 페이지 안의 정책

일반 앱은 Content-Security-Policy 헤더와 함께 나갑니다. GitHub Pages는 직접 정한 헤더를 보내지 않으므로, 데모는 같은 정책을 charset 바로 다음의 `<meta http-equiv="Content-Security-Policy">`로 담습니다. 원본은 여전히 `config/headers.ts` 하나이며, `<meta>`가 담을 수 없는 지시어만 빠집니다.

* **유지되는 것:** `default-src 'none'`, 스크립트·스타일·글꼴·Worker·그림·연결은 사이트 자신(`'self'`, 그림은 `blob:`과 `data:`도)에서만, `unsafe-eval` 없음, `base-uri 'none'`, `form-action 'self'`. 테스트가 헤더 없이 데모를 띄워, 끼워 넣은 인라인 스크립트가 돌지 않고 다른 사이트 요청이 막히는 것을 확인합니다. 리퍼러 규칙(`no-referrer`)은 `<meta name="referrer">`로 정합니다.
* **헤더로만 되므로 유지되지 않는 것:** `frame-ancestors`와 `X-Frame-Options`(다른 사이트가 데모를 프레임에 넣을 수 있음), `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`, `X-Content-Type-Options`, `Strict-Transport-Security`(GitHub가 자기 도메인에 정함). 데모에는 계정, 키, 개인 데이터가 없으므로 이것들이 지킬 값진 것은 없지만, 있다고 오해하지 않도록 적어 둡니다.
* 페이지 안의 정책은 브라우저가 그 줄에 닿을 때부터 적용됩니다. 모든 스크립트와 스타일시트보다 앞에 두며, `index.html`에 끼워 넣을 표지가 없으면 빌드가 실패합니다.

## 보장과 그것을 확인하는 테스트

| 보장 | 테스트 |
|---|---|
| 데모 번들에는 AI 클라이언트, 서비스 주소, 키가 없음 | `tests/demo.build.test.ts` (실제로 빌드), `tests/e2e/demo-site.spec.ts` (서버가 내주는 모든 파일을 읽음) |
| AI 대체 모듈은 진짜 클라이언트와 같은 것을 제공하고 `fetch`, XHR, WebSocket을 부르지 않음 | `tests/demo.ai-stub.test.ts` |
| 방문자 브라우저는 사이트 자신의 파일만 요청하고 `/api/` 아래는 요청하지 않음. 학습 세션 내내 콘솔 오류나 정책 위반 없음 | `tests/e2e/demo-site.spec.ts` |
| 정책이 페이지 안, 모든 스크립트 앞에 있고, 헤더가 없을 때 적용되는 것이 그 정책임 | `tests/demo.policy.test.ts`, `tests/demo.build.test.ts`, `tests/e2e/demo-site.spec.ts` |
| 파일 읽기 Worker까지 하위 경로에서 동작하고 404.html이 앱임 | `tests/demo.build.test.ts`, `tests/e2e/demo-site.spec.ts` |
| 일반 앱은 바뀌지 않음: 루트 경로, `_headers`, 진짜 AI 클라이언트, 데모 코드 없음 | `tests/demo.build.test.ts`와 기존 테스트 전체 |
| 예시 과목은 앱 자신의 검사를 통과하고(모든 인용을 찾고 어떤 문제에도 지적이 없음), 다양하며, 가상 내용만 있음 | `tests/demo.sample-course.test.ts` |
| 배너와 예시 과목은 밝은·어두운 테마에서 접근성 검사를 통과하고 휴대폰에 맞음 | `tests/e2e/demo-site.spec.ts` |
| 워크플로는 손으로만 시작되고, 모든 액션을 커밋으로 고정하며, 게시 권한은 배포 작업에만 있음 | `tests/demo.workflow.test.ts` |

브라우저 테스트는 `pnpm check`로 돕니다([CONTRIBUTING.md](../CONTRIBUTING.md)). 실제 데모 빌드를 포함한 단위 테스트는 CI에서 `pnpm test`로 돕니다.

## 게시하기

`.github/workflows/demo.yml`이 데모를 빌드하고 GitHub 공식 Pages 액션(`configure-pages`, `upload-pages-artifact`, `deploy-pages`)으로 배포하며, 각 액션은 전체 커밋 SHA로 고정되어 있습니다. 손으로 시작할 때(`workflow_dispatch`)**만** 돕니다. 병합이나 푸시는 아무것도 게시하지 않고, 워크플로는 Pages를 켜거나 설정을 바꾸지 않습니다.

저장소 주인이 한 번 해야 하는 일(이 저장소의 어떤 파일도 대신하지 않음):

1. 저장소에서 **Settings → Pages → Build and deployment → Source: GitHub Actions**.

데모를 게시하거나 새로 고칠 때마다:

1. **Actions → Demo → Run workflow**, 브랜치 `main`. 설치, 테스트, 데모 빌드, 배포를 하고 배포 단계가 주소를 보여 줍니다.
2. 다른 브랜치에서 시작하면 빌드만 하고 멈춥니다. 기본 브랜치만 배포됩니다.

내리려면 **Settings → Pages → Unpublish site**. 다른 이름의 포크로 게시할 때도 바꿀 것이 없습니다. 워크플로가 Pages에 경로(`base_path`)를 물어 그에 맞게 빌드합니다.

## 한계

* **GitHub가 내줍니다.** 방문자 브라우저는 `github.io`에서 페이지와 파일을 받고, GitHub는 다른 호스트처럼 그 방문을 봅니다. 앱이 보태는 것은 없습니다. 분석, 다른 사이트 요청, 쿠키가 없습니다. 배너의 저장소 링크는 보통 링크이며 누를 때만 이동합니다.
* **출처를 공유합니다.** 같은 계정의 모든 GitHub Pages 사이트는 `yenakim2004.github.io`에 있고, 브라우저는 한 출처의 페이지끼리 IndexedDB와 로컬 저장소를 공유합니다. 데모는 `studyai`라는 데이터베이스를 쓰므로 같은 출처의 다른 프로젝트가 읽을 수 있고 그 반대도 됩니다. 데모에는 비밀이 없지만, 그곳에 비밀을 저장하는 다른 앱을 올리지 말고, 함께 쓰는 브라우저에서 데모에 실제 강의를 넣지 마세요.
* **데이터는 브라우저마다.** 사이트 데이터 지우기, 비공개 창, 일부 개인정보 설정은 데이터를 지우거나 막습니다. 데모도 실제 앱처럼 백업을 내보낼 수 있습니다(설정).
* **깊은 주소에서 새로 고치면 GitHub Pages가 404 상태로 답합니다**(본문은 앱이라 동작함). 검색 엔진은 그런 주소를 없는 것으로 볼 수 있습니다. 첫 페이지는 보통 200입니다.
* **설계상 AI가 없습니다.** 튜터, AI 채점, 시험 점검, 생성은 화면만 있고 쓸 수 없다고 말합니다. 써 보려면 내 컴퓨터에서 `pnpm local`로 실행하세요(README, [CHATGPT.md](CHATGPT.md)).
* **예시는 일부러 작습니다**(강의 둘, 슬라이드 14장). 기능을 보여 줄 뿐 공부할 과목이 아니며 그 안의 "규칙"은 지어낸 것입니다.
* **브라우저.** 앱이 필요한 것, 즉 IndexedDB와 Web Worker가 있는 최신 브라우저가 필요합니다. Chrome에서만 시험했습니다.
