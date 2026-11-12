# StudyAI

[![CI](https://github.com/yenakim2004/studyai/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yenakim2004/studyai/actions/workflows/ci.yml) [![보안 검사](https://github.com/yenakim2004/studyai/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/yenakim2004/studyai/actions/workflows/codeql.yml)

**PPTX·PDF 강의 자료를 넣고, 한국어로 공부하는 학습 도우미입니다.** 자료 보기와 검색, 노트, 플래시카드, 모의시험을 한곳에서 사용할 수 있습니다. 내 컴퓨터에서 실행하면 내 ChatGPT 플랜을 연결해 자료를 근거로 설명을 듣고 문제를 만들 수 있습니다.

강의 파일과 학습 기록은 브라우저에 저장됩니다. StudyAI 자체 로그인이나 Owner key는 없습니다. AI에 질문할 때는 보낼 텍스트와 출처를 먼저 보여 줍니다.

## 실행 방식 고르기

| | 내 컴퓨터에서 사용 | Sites에 웹 앱으로 배포 |
|---|---|---|
| 실행·빌드 | `pnpm local` | `pnpm build:sites-server` |
| PPTX·PDF 보기와 검색 | 가능 | 가능 |
| 노트·카드·모의시험·백업 | 가능 | 가능 |
| 내 ChatGPT 플랜으로 AI 사용 | 설정에서 연결 후 가능 | 암호화 파일로 연결하는 실험 기능. 실제 계정 검증 필요 |
| 자료 저장 | 해당 주소의 브라우저 저장소 | 방문자별 브라우저 저장소 |
| 서버에 강의 저장·기기 간 동기화 | 없음 | 없음 |

Sites의 사이트 접근 로그인과 ChatGPT 플랜으로 모델을 호출하는 권한은 별개입니다. 배포 사이트에 접속했다고 AI 튜터가 자동으로 연결되지는 않습니다.

## 설치하고 바로 시작하기

준비물은 **Node.js 22 이상**, **Git**, 최신 브라우저입니다. 아래 명령은 pnpm을 전역에 설치하지 않아도 실행되며, 프로젝트에 맞는 pnpm 11.28.11을 사용합니다. 처음 설치할 때는 인터넷 연결이 필요합니다.

```bash
git clone https://github.com/yenakim2004/studyai.git
cd studyai
npx --yes pnpm@11.28.11 install --frozen-lockfile
npx --yes pnpm@11.28.11 local
```

1. 터미널에 표시된 **http://127.0.0.1:8790**을 여세요. 터미널은 켜 둡니다.
2. **과목 만들기**를 누르고 강의 파일을 추가하세요.
3. AI도 사용하려면 **설정과 백업 → AI 학습 도우미 → ChatGPT로 계속하기**를 누르세요. OpenAI에서 허용한 뒤 설정으로 돌아와 사용할 모델을 고릅니다.
4. 과목의 **AI 튜터**에서 질문과 함께 보낼 자료를 확인하고 보내세요.

AI를 연결하지 않아도 자료 보기와 학습 기능은 동작합니다. 이미 연결한 계정은 다음 실행 때 이어집니다. 종료는 실행한 터미널에서 `Ctrl+C`, 다시 시작할 때는 `studyai` 폴더에서 마지막 명령만 실행하면 됩니다. 별도로 `.env`를 만들거나 토큰을 복사할 필요가 없습니다.

이미 pnpm 11.28.11이 있다면 이후 명령의 `npx --yes pnpm@11.28.11` 대신 `pnpm`을 쓸 수 있습니다. 저장소는 `packageManager`에 이 버전을 고정합니다.

### 문제가 생겼을 때

| 증상 | 확인할 것 |
|---|---|
| `node` 또는 `npx`를 찾지 못함 | Node.js 22 이상을 설치하고 새 터미널을 여세요. `node --version`으로 확인합니다. |
| pnpm 설정·lockfile 오류 | 위의 버전 고정 명령으로 설치하세요. 오래된 전역 pnpm을 쓰지 마세요. |
| 8790 포트가 사용 중 | 이미 실행한 StudyAI 창이 있는지 확인하고 중복 실행을 종료하세요. |
| AI 연결이 안 됨 | `localhost` 대신 터미널에 나온 `127.0.0.1` 주소로 여세요. `pnpm dev`와 정적 배포에는 AI 서버가 없습니다. |
| 자료가 갑자기 없어 보임 | 주소, 포트, 브라우저 프로필이 바뀌면 다른 자료실입니다. 원래 주소로 돌아가 백업을 내보낸 뒤 새 주소에서 복원하세요. |
| PDF에 글이 없다고 나옴 | 스캔 PDF는 페이지 그림으로 표시합니다. 자동 OCR은 없으며, 필요한 글은 직접 입력할 수 있습니다. |

연결 해제, 저장 위치와 보안 설명은 [ChatGPT 연결 안내](docs/CHATGPT.md)를 보세요.

## 내 비공개 Sites로 배포하기

각 사용자가 자신의 비공개 사이트를 만들고 자신의 ChatGPT 계정을 연결하는 구성입니다. 강의와 학습 기록은 해당 주소의 브라우저에 저장되고, ChatGPT 연결 정보만 사이트의 D1에 암호화해 저장합니다.

Sites에 다음처럼 요청할 수 있습니다.

```text
@Sites https://github.com/yenakim2004/studyai 를 내 비공개 사이트로 배포해 줘.
docs/SITES.md의 개인 서버 배포 절차를 따라 build:sites-server로 빌드해 줘.
D1과 서버 비밀 설정을 구성하고, 내 컴퓨터의 기존 ChatGPT 인증 파일은 복사하지 마.
```

설정에서 요청 파일을 내려받고, Node.js 22 이상이 설치된 컴퓨터에서 사이트가 제공하는 연결 도구를 실행합니다. 도구가 안내하는 OpenAI 주소에서 로그인한 뒤 만들어진 암호화 파일을 같은 사이트에 올립니다. 토큰을 복사해 붙여 넣거나 `.env`에 넣지 않습니다. 연결 후에는 사이트가 갱신을 담당하므로 로컬 도구는 꺼도 됩니다.

이 연결은 **실험 기능**입니다. 가짜 발급자와 실제 로컬 D1을 사용한 검증은 실제 OpenAI 계정의 연결·추론·갱신 성공을 보장하지 않습니다. OpenAI의 개인 VM 안내가 Sites에도 적용되는지는 확인되지 않았습니다. 사이트 로그인만으로 ChatGPT 플랜 권한이 생기지는 않습니다.

AI 없이 쓰는 정적 배포도 유지됩니다. `pnpm build:sites`는 정적 `dist/`를 만들고, `pnpm preview:sites`는 이를 로컬에서 확인합니다. `build:sites-server`는 D1을 사용하는 서버와 앱 파일을 만듭니다. 상세 설정, 설치 명령과 검증 항목은 [Sites 배포 안내](docs/SITES.md)에 있습니다. GitHub 푸시만으로 Sites에 게시되지는 않습니다.

## 학습 기능

- **자료 보기와 검색.** PPTX의 글, 표, 차트, 발표자 노트, 수식을 읽고 PDF는 쪽별 그림과 텍스트를 함께 보여 줍니다. 읽지 못한 부분은 추출 보고서에 표시합니다.
- **복습.** 노트와 FSRS 간격 반복 플래시카드, 채점 기준이 있는 모의시험, 학습 진도를 제공합니다. 자료에서 만든 초안과 AI가 만든 항목은 검토 후 승인합니다.
- **근거 확인.** AI가 인용한 문장을 강의에서 찾아 확인하고, 자료 밖의 설명과 불확실한 내용을 구분합니다. 질문 생성과 채점은 한국어를 기본으로 요청하며 원문 자료는 번역하거나 바꾸지 않습니다.
- **화면 공간.** 왼쪽 사이드바를 접고 펼칠 수 있습니다. 컴퓨터에서는 선택을 기억하고, 휴대폰에서는 메뉴 서랍을 사용합니다.
- **백업과 복원.** 설정에서 강의와 학습 기록을 ZIP으로 내보내거나 복원합니다. 브라우저 데이터 삭제에 대비해 정기적으로 백업하세요. 백업에는 ChatGPT 인증 정보가 들어가지 않습니다.

지원 파일은 `.pptx`, `.pptm`, `.ppsx`, `.potx`, `.pdf`입니다. 오래된 `.ppt`는 PowerPoint에서 `.pptx`로 다시 저장하세요. PDF의 다단 편집, 표와 수식은 읽는 순서나 텍스트가 원본과 다를 수 있습니다. 스캔 PDF에는 자동 OCR이 없습니다.

## 개발과 검증

```bash
pnpm dev                  # AI 없는 개발 서버, http://localhost:5173
pnpm build                # 로컬 Worker와 함께 쓸 운영 빌드
pnpm typecheck:worker     # Worker 타입 검사
pnpm test                 # 단위·통합 테스트
pnpm check                # 빌드, Worker 타입, 단위·브라우저 테스트
pnpm test:e2e:sites        # 정적 배포 빌드의 PDF·사이드바·설정 흐름
pnpm scan:secrets          # 작업 트리와 git 기록의 비밀 값 검사
pnpm check:attribution    # 커밋의 자동 생성 서명 검사
```

브라우저 테스트에는 Chrome이 필요합니다. 테스트는 가상 강의와 가짜 OpenAI 서버를 사용하며 실제 계정에 요청하지 않습니다. `STUDYAI_E2E_PORT_BASE`로 테스트 포트를 바꿀 수 있습니다. 자세한 개발 절차는 [기여 안내](CONTRIBUTING.md), 공개 예제용 GitHub Pages 배포는 [데모 안내](docs/DEMO.md)를 참고하세요.

## 보안과 라이선스

`.studyai-local/`에는 로컬 ChatGPT 연결 상태와 암호화 키가 있습니다. 이 폴더를 git, 배포 파일, 다른 사람에게 전달하는 ZIP에 넣지 마세요. 로컬 서버는 같은 컴퓨터의 프로그램이 사용할 수 있으므로 인터넷 터널로 공개하지 마세요. 자세한 내용은 [보안 안내](SECURITY.md)에 있습니다.

코드는 [MIT](LICENSE), 포함된 라이브러리는 [오픈소스 고지](THIRD-PARTY-NOTICES.md)를 따릅니다. 강의 자료의 권리는 저자에게 있습니다. 이 저장소에는 합성한 테스트 자료만 포함하며 실제 강의와 계정 정보는 포함하지 않습니다.
