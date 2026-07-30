const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const PAGE_W = 841.89; // A4 landscape
const PAGE_H = 595.28;
const MARGIN = 40;

const COLORS = {
  ink: rgb(0.11, 0.13, 0.15),
  muted: rgb(0.45, 0.48, 0.5),
  rule: rgb(0.82, 0.84, 0.85),
  headerBg: rgb(0.13, 0.16, 0.18),
  headerText: rgb(1, 1, 1),
  top: rgb(0.75, 0.32, 0.1),      // amber/rust - "Top" faults
  alignment: rgb(0.13, 0.4, 0.62), // blue - "Alignment" faults
  severe: rgb(0.72, 0.11, 0.11),
  moderate: rgb(0.75, 0.5, 0.05),
  slight: rgb(0.25, 0.5, 0.25),
};

function fmtMileage(miles, yards) {
  if (miles === null || miles === undefined) return '—';
  return `${miles}m ${String(yards ?? 0).padStart(4, '0')}yd`;
}

function fmtDate(d) {
  const dt = new Date(d);
  return dt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

async function buildRidePdf(ride, faults) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const colWidths = [70, 55, 65, 75, 90, 85, 60, 75]; // Time, ELR, Track, Mileage, Type, Severity, Accuracy, Notes-lead
  const headers = ['Time (UTC)', 'ELR', 'Track ID', 'Mileage/Yds', 'Fault Type', 'Severity', 'GPS ±m', 'Notes'];

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function drawHeader(p, yy) {
    p.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: COLORS.headerBg });
    p.drawText('Track Geometry Fault Report', {
      x: MARGIN, y: PAGE_H - 32, size: 18, font: bold, color: COLORS.headerText,
    });
    p.drawText(`${ride.name}`, {
      x: MARGIN, y: PAGE_H - 52, size: 11, font, color: rgb(0.85, 0.87, 0.88),
    });
    const rightText = `Rider: ${ride.rider_name || '—'}    Started: ${fmtDate(ride.started_at)}`;
    const w = font.widthOfTextAtSize(rightText, 9);
    p.drawText(rightText, { x: PAGE_W - MARGIN - w, y: PAGE_H - 32, size: 9, font, color: rgb(0.85, 0.87, 0.88) });
    const rightText2 = ride.ended_at ? `Ended: ${fmtDate(ride.ended_at)}` : 'Ride status: in progress';
    const w2 = font.widthOfTextAtSize(rightText2, 9);
    p.drawText(rightText2, { x: PAGE_W - MARGIN - w2, y: PAGE_H - 48, size: 9, font, color: rgb(0.85, 0.87, 0.88) });
    return PAGE_H - 95;
  }

  function drawTableHeader(p, yy) {
    p.drawRectangle({ x: MARGIN, y: yy - 18, width: PAGE_W - 2 * MARGIN, height: 20, color: rgb(0.92, 0.93, 0.94) });
    let x = MARGIN + 6;
    headers.forEach((h, i) => {
      p.drawText(h, { x, y: yy - 13, size: 9, font: bold, color: COLORS.ink });
      x += colWidths[i];
    });
    return yy - 24;
  }

  y = drawHeader(page, y);
  y = drawTableHeader(page, y);

  const rowH = 20;
  for (const f of faults) {
    if (y < MARGIN + rowH) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      y = drawTableHeader(page, y);
    }
    let x = MARGIN + 6;
    const typeColor = f.fault_type === 'top' ? COLORS.top : COLORS.alignment;
    const sevColor = f.severity === 'severe' ? COLORS.severe : f.severity === 'slight' ? COLORS.slight : COLORS.moderate;

    const cells = [
      new Date(f.captured_at).toISOString().slice(11, 19),
      f.elr || '—',
      f.track_id || '—',
      fmtMileage(f.mileage_miles, f.mileage_yards),
    ];
    cells.forEach((c, i) => {
      page.drawText(String(c), { x, y: y - 13, size: 9, font: i === 3 ? mono : font, color: COLORS.ink });
      x += colWidths[i];
    });

    // Fault type badge
    const typeLabel = f.fault_type === 'top' ? 'TOP' : 'ALIGNMENT';
    page.drawRectangle({ x, y: y - 16, width: colWidths[4] - 10, height: 14, color: typeColor });
    page.drawText(typeLabel, { x: x + 4, y: y - 12.5, size: 8, font: bold, color: rgb(1, 1, 1) });
    x += colWidths[4];

    // Severity badge
    const sevLabel = f.severity.toUpperCase();
    page.drawRectangle({ x, y: y - 16, width: colWidths[5] - 10, height: 14, color: sevColor });
    page.drawText(sevLabel, { x: x + 4, y: y - 12.5, size: 8, font: bold, color: rgb(1, 1, 1) });
    x += colWidths[5];

    page.drawText(f.gps_accuracy_m ? `${Math.round(f.gps_accuracy_m)}` : '—', {
      x, y: y - 13, size: 9, font, color: COLORS.muted,
    });
    x += colWidths[6];

    const notes = (f.notes || '').slice(0, 65);
    page.drawText(notes, { x, y: y - 13, size: 8, font, color: COLORS.muted });

    page.drawLine({
      start: { x: MARGIN, y: y - rowH + 2 }, end: { x: PAGE_W - MARGIN, y: y - rowH + 2 },
      thickness: 0.5, color: COLORS.rule,
    });

    y -= rowH;
  }

  // Summary footer on last page
  if (y < MARGIN + 60) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }
  const topCount = faults.filter((f) => f.fault_type === 'top').length;
  const alignCount = faults.filter((f) => f.fault_type === 'alignment').length;
  const severeCount = faults.filter((f) => f.severity === 'severe').length;
  y -= 20;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: COLORS.rule });
  y -= 18;
  page.drawText(
    `Summary — Total faults: ${faults.length}    Top: ${topCount}    Alignment: ${alignCount}    Severe: ${severeCount}`,
    { x: MARGIN, y, size: 10, font: bold, color: COLORS.ink }
  );

  // Footer with generation timestamp on every page
  const pages = doc.getPages();
  pages.forEach((p, idx) => {
    p.drawText(`Generated ${fmtDate(new Date())}  •  Page ${idx + 1} of ${pages.length}`, {
      x: MARGIN, y: 20, size: 7, font, color: COLORS.muted,
    });
  });

  return doc.save();
}

module.exports = { buildRidePdf };
