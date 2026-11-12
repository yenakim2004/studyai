export function pdfWithBookmarkTarget(target: number): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> >>',
    '<< /Type /Outlines /First 5 0 R /Last 6 0 R /Count 2 >>',
    '<< /Title (Intro) /Parent 4 0 R /Next 6 0 R /Dest [0 /Fit] >>',
    `<< /Title (Broken) /Parent 4 0 R /Prev 5 0 R /Dest [${target} /Fit] >>`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
