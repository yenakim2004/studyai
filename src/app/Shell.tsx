import { createContext, Suspense, useContext, useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BookOpen, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Sun, X } from 'lucide-react';
import { getDb } from '@/core/db/db';
import { createCourse } from '@/core/db/library';
import { DemoBanner } from '@/demo/DemoBanner';
import { Button, Dialog, Field, IconButton, TextInput } from '@/ui/primitives';
import { useAllLectures, useCourses } from './data';
import { useTheme, type ThemeChoice } from './theme';
import { useToast } from './toast';

const db = getDb();

export const COURSE_COLORS = ['#0b6e6e', '#2b5fa6', '#7a3e9d', '#b4531f', '#8a6d00', '#a6325d', '#3f7a2a', '#556270'];

const THEME_NAME: Record<ThemeChoice, string> = { system: '시스템 설정', light: '밝게', dark: '어둡게' };

/** The desktop sidebar's folded state is a per-device preference; phones always use the menu drawer instead. */
const SIDEBAR_KEY = 'studyai.sidebar';
const SIDEBAR_ID = 'app-sidebar';
const DRAWER_ID = 'app-menu';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function saveCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_KEY, 'collapsed');
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    /* storage can be unavailable (private mode); the choice still holds for this visit */
  }
}

interface ShellApi {
  openNewCourse: () => void;
}
const ShellCtx = createContext<ShellApi>({ openNewCourse: () => undefined });
export const useShell = (): ShellApi => useContext(ShellCtx);

export function Shell() {
  const courses = useCourses();
  const lectures = useAllLectures();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { choice, setChoice } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [newCourse, setNewCourse] = useState(false);
  const [q, setQ] = useState('');
  const drawer = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  /** Set by the fold/unfold buttons only, so the page load never moves focus. */
  const moveFocus = useRef(false);

  // Close the mobile menu on navigation.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // The drawer is a native modal dialog: it traps focus, closes on Escape and makes the page behind it inert.
  useEffect(() => {
    const el = drawer.current;
    if (!el) return;
    if (menuOpen && !el.open) el.showModal();
    if (!menuOpen && el.open) el.close();
  }, [menuOpen]);

  // Growing the window to desktop width while the drawer is open leaves the sidebar in charge.
  useEffect(() => {
    const mq = window.matchMedia?.('(min-width: 48rem)');
    if (!mq) return;
    const on = () => mq.matches && setMenuOpen(false);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    saveCollapsed(collapsed);
    if (!moveFocus.current) return;
    moveFocus.current = false;
    // The button that was pressed disappears; its counterpart takes the focus so the keyboard user stays in place.
    (collapsed ? expandButton : collapseButton).current?.focus();
  }, [collapsed]);

  const toggleSidebar = (next: boolean) => {
    moveFocus.current = true;
    setCollapsed(next);
  };

  const counts = new Map<string, number>();
  for (const l of lectures ?? []) counts.set(l.courseId, (counts.get(l.courseId) ?? 0) + 1);
  const active = (courses ?? []).filter((c) => !c.archived);
  const archived = (courses ?? []).filter((c) => c.archived);

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) navigate(`/search?q=${encodeURIComponent(term)}`);
  };

  const nextTheme = () => setChoice(choice === 'system' ? 'light' : choice === 'light' ? 'dark' : 'system');
  const ThemeIcon = choice === 'system' ? Monitor : choice === 'light' ? Sun : Moon;

  const link = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-sm ${isActive ? 'bg-accent-soft font-medium text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink'}`;

  // The sidebar is rendered twice (desktop column + phone drawer): use implicit labels, never a shared id.
  const sidebar = (place: 'desktop' | 'drawer') => (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <div className="flex items-center justify-between px-1.5 pt-1">
        <NavLink to="/" className="text-[17px] font-semibold tracking-tight text-ink" aria-label="StudyAI 홈">
          Study<span className="text-accent">AI</span>
        </NavLink>
        {place === 'drawer' ? (
          <IconButton label="메뉴 닫기" onClick={() => setMenuOpen(false)}>
            <X className="size-5" aria-hidden />
          </IconButton>
        ) : (
          <IconButton ref={collapseButton} label="사이드바 접기" aria-expanded="true" aria-controls={SIDEBAR_ID} onClick={() => toggleSidebar(true)} className="-mr-1.5">
            <PanelLeftClose className="size-5" aria-hidden />
          </IconButton>
        )}
      </div>

      <form onSubmit={submitSearch} role="search">
        <label className="relative block">
          <span className="sr-only">모든 강의 검색</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="강의 검색" className="pl-8" />
        </label>
      </form>

      <nav aria-label="주 메뉴" className="flex flex-col gap-0.5">
        <NavLink to="/" end className={link}>
          <BookOpen className="size-4" aria-hidden /> 대시보드
        </NavLink>
        <NavLink to="/settings" className={link}>
          <Settings className="size-4" aria-hidden /> 설정과 백업
        </NavLink>
      </nav>

      <nav aria-label="과목" className="flex min-h-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between px-2.5">
          <h2 className="text-[13px] font-semibold text-ink-2">과목</h2>
          <IconButton label="새 과목" onClick={() => setNewCourse(true)} className="-mr-2 size-8">
            <Plus className="size-4" aria-hidden />
          </IconButton>
        </div>
        {courses === undefined ? null : active.length === 0 ? (
          <p className="px-2.5 text-[13px] text-ink-3">아직 과목이 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {active.map((c) => (
              <li key={c.id}>
                <NavLink to={`/course/${c.id}`} className={link}>
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: COURSE_COLORS[c.color % COURSE_COLORS.length] }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="text-xs text-ink-3" aria-label={`강의 ${counts.get(c.id) ?? 0}개`}>
                    {counts.get(c.id) ?? 0}
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
        {archived.length > 0 && (
          <details className="mt-2 px-1">
            <summary className="cursor-pointer px-1.5 py-1 text-[13px] text-ink-3">보관함({archived.length})</summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {archived.map((c) => (
                <li key={c.id}>
                  <NavLink to={`/course/${c.id}`} className={link}>
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </details>
        )}
      </nav>

      <div className="flex items-center justify-between border-t border-rule px-1 pt-3">
        <p className="text-xs text-ink-3">이 기기에만 저장됩니다</p>
        <IconButton label={`테마: ${THEME_NAME[choice]}. 눌러서 바꾸기`} onClick={nextTheme} className="-mr-2 size-9">
          <ThemeIcon className="size-4" aria-hidden />
        </IconButton>
      </div>
    </div>
  );

  return (
    <ShellCtx.Provider value={{ openNewCourse: () => setNewCourse(true) }}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink">
        본문으로 건너뛰기
      </a>
      <div className={`min-h-dvh print:block md:grid ${collapsed ? 'md:grid-cols-[3rem_minmax(0,1fr)]' : 'md:grid-cols-[264px_minmax(0,1fr)]'}`}>
        {/* Folded on a desktop: a slim rail keeps the way back without a bar over the pages' own sticky headers. */}
        {collapsed && (
          <div className="sticky top-0 hidden h-dvh flex-col items-center border-r border-rule bg-surface py-2 md:flex print:hidden">
            <IconButton ref={expandButton} label="사이드바 펼치기" aria-expanded="false" aria-controls={SIDEBAR_ID} onClick={() => toggleSidebar(false)}>
              <PanelLeftOpen className="size-5" aria-hidden />
            </IconButton>
          </div>
        )}
        {/* Folded: display none, so nothing inside can take focus; the element stays so aria-controls always resolves. */}
        <aside id={SIDEBAR_ID} className={`sticky top-0 h-dvh border-r border-rule bg-surface print:hidden ${collapsed ? 'hidden' : 'hidden md:block'}`} aria-label="사이드바">
          {sidebar('desktop')}
        </aside>

        <div className="min-w-0">
          {/* Only the static public demo (vite build --mode demo) has a banner; the regular build compiles it away. */}
          {import.meta.env.MODE === 'demo' && <DemoBanner />}
          <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-rule bg-surface px-3 py-2 md:hidden print:hidden">
            <IconButton ref={menuButton} label="메뉴 열기" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls={DRAWER_ID} onClick={() => setMenuOpen(true)} className="md:hidden">
              <Menu className="size-5" aria-hidden />
            </IconButton>
            <NavLink to="/" className="text-[17px] font-semibold tracking-tight">
              Study<span className="text-accent">AI</span>
            </NavLink>
          </header>
          <main id="main" className="min-w-0">
            <Suspense
              fallback={
                <div className="p-6 text-sm text-ink-2" role="status">
                  불러오는 중…
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>

      <dialog
        ref={drawer}
        id={DRAWER_ID}
        aria-label="메뉴"
        onClose={() => {
          setMenuOpen(false);
          menuButton.current?.focus();
        }}
        onClick={(e) => {
          if (e.target === drawer.current) setMenuOpen(false);
        }}
        className="m-0 h-dvh max-h-none w-[min(20rem,86vw)] max-w-none border-0 bg-surface p-0 shadow-xl md:hidden"
      >
        {menuOpen && sidebar('drawer')}
      </dialog>

      <NewCourseDialog
        open={newCourse}
        onClose={() => setNewCourse(false)}
        onCreate={async (name, code) => {
          try {
            const c = await createCourse(db, { name, code });
            setNewCourse(false);
            navigate(`/course/${c.id}`);
          } catch (err) {
            toast.show(err instanceof Error ? err.message : '과목을 만들지 못했습니다.', 'error');
          }
        }}
      />
    </ShellCtx.Provider>
  );
}

function NewCourseDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (name: string, code?: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setCode('');
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="새 과목"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button variant="primary" type="submit" form="new-course-form" disabled={!name.trim() || busy}>
            만들기
          </Button>
        </>
      }
    >
      <form
        id="new-course-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || busy) return;
          setBusy(true);
          void onCreate(name, code || undefined).finally(() => setBusy(false));
        }}
      >
        <Field label="과목 이름" htmlFor="course-name">
          <TextInput id="course-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="계산 이론" autoFocus />
        </Field>
        <Field label="과목 코드(선택)" htmlFor="course-code">
          <TextInput id="course-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="CS301" />
        </Field>
      </form>
    </Dialog>
  );
}
