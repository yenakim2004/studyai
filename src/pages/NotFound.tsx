import { Link } from 'react-router';

/** `what` names the missing thing with its particle, such as "과목이" or "페이지가". */
export function NotFound({ what = '페이지가' }: { what?: string }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">그런 {what} 없습니다</h1>
      <p className="mt-2 text-sm text-ink-2">삭제되었거나 링크가 잘못되었을 수 있습니다. 라이브러리는 이 브라우저에만 저장되므로 다른 기기나 브라우저의 링크로는 열리지 않습니다.</p>
      <p className="mt-4">
        <Link to="/" className="font-medium text-accent underline underline-offset-2">
          대시보드로 가기
        </Link>
      </p>
    </div>
  );
}
