import { useEffect, useRef } from "react";

type Cell = { x: number; y: number; phase: number; heat: number };
const PITCH_X = 23;
const PITCH_Y = 18.5;
const SPRITE_SIZE = 40;
const COLOR_FRAMES = 192;
const FIRST_ROW_CENTER = 14;

// Each cell has its own light level. The cursor hits one heart, never a radial field.
export default function HeartField({ paused }: { paused: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const clock = useRef(0);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !ctx) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const compact = window.matchMedia("(max-width: 767px)");
    const header = document.querySelector<HTMLElement>(".site-header");
    let width = 0, height = 0, columns = 0, rows = 0, frame = 0, previous = 0;
    let topInset = 0;
    let cells: Cell[] = [];
    let hovered = -1;
    let lastPoint: { x: number; y: number } | null = null;
    const heart = new Path2D("M12 21.5C10 19.7 1 13.8 1 7.8C1 1.8 8.3.1 12 5.4C15.7.1 23 1.8 23 7.8C23 13.8 14 19.7 12 21.5Z");
    // CHOG's violet / fuchsia light spectrum. White is a short moving crest,
    // not a screen-wide flash; the troughs stay visibly purple.
    const colors = [
      [64, 27, 137], [94, 40, 199], [137, 67, 255], [150, 73, 255],
      [215, 54, 184], [242, 65, 173], [255, 158, 218], [255, 236, 255],
      [247, 133, 211], [226, 52, 174], [140, 63, 245], [83, 34, 171],
      [64, 27, 137],
    ];
    const colorAt = (phase: number) => {
      const position = ((phase % 1 + 1) % 1) * (colors.length - 1);
      const index = Math.floor(position);
      const fraction = position - index;
      const blend = fraction * fraction * (3 - 2 * fraction);
      return `rgb(${colors[index].map((value, channel) => Math.round(value + (colors[index + 1][channel] - value) * blend)).join(",")})`;
    };
    const makeSprite = (phase: number, glowing = false) => {
      const sprite = document.createElement("canvas");
      sprite.width = sprite.height = 80;
      const brush = sprite.getContext("2d")!;
      brush.scale(2, 2); brush.translate(8, 8);
      brush.shadowColor = colorAt(phase);
      const gradient = brush.createLinearGradient(2, 1, 22, 22);
      gradient.addColorStop(0, colorAt(phase + .018));
      gradient.addColorStop(.5, colorAt(phase));
      gradient.addColorStop(1, colorAt(phase - .018));
      // Opaque color fills the entire heart, not just a translucent contour.
      brush.shadowBlur = 0;
      brush.globalAlpha = 1;
      brush.fillStyle = gradient;
      brush.fill(heart);
      brush.globalAlpha = 1;
      brush.shadowBlur = glowing ? 4 : 0;
      brush.strokeStyle = gradient;
      brush.lineWidth = glowing ? 1.15 : .65;
      brush.lineJoin = "round";
      brush.stroke(heart);
      if (glowing) {
        brush.shadowBlur = 0;
        brush.strokeStyle = "#f8f3ffb0";
        brush.lineWidth = .45; brush.stroke(heart);
      }
      return sprite;
    };
    const baseSprites = Array.from({ length: COLOR_FRAMES }, (_, i) => makeSprite(i / COLOR_FRAMES));
    const litSprites = Array.from({ length: COLOR_FRAMES }, (_, i) => makeSprite(i / COLOR_FRAMES, true));
    const cellAt = (x: number, y: number) => {
      if (y < topInset) return -1;
      const column = Math.round((x - PITCH_X / 2) / PITCH_X);
      const row = Math.round((y - topInset - FIRST_ROW_CENTER) / PITCH_Y);
      return column >= 0 && column < columns && row >= 0 && row < rows ? row * columns + column : -1;
    };
    const paint = (delta = 0) => {
      ctx.clearRect(0, 0, width, height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, topInset, width, Math.max(0, height - topInset));
      ctx.clip();
      ctx.translate(0, topInset);
      const t = clock.current / 1000;
      const fade = Math.exp(-delta / 230);
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        cell.heat = i === hovered ? 1 : cell.heat * fade;
        // Two slow, overlapping currents bend the light fronts into ribbons.
        // No random frame-to-frame flicker and no blur over the whole field.
        const drift = .16 * Math.sin(cell.y / 170 - t * .58)
          + .1 * Math.sin(cell.x / 240 + cell.y / 290 + t * .39);
        const cycle = (cell.phase - t * .105 + drift) % 1;
        const colorIndex = Math.floor((cycle + 1) % 1 * COLOR_FRAMES);
        ctx.globalAlpha = 1;
        ctx.drawImage(baseSprites[colorIndex], cell.x - 20, cell.y - 20, SPRITE_SIZE, SPRITE_SIZE);
        if (cell.heat > .015) {
          ctx.globalAlpha = cell.heat;
          ctx.drawImage(litSprites[colorIndex], cell.x - 20, cell.y - 20, SPRITE_SIZE, SPRITE_SIZE);
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    };
    const tick = (time: number) => {
      if (!previous) previous = time;
      const elapsed = time - previous;
      if (elapsed >= (compact.matches ? 50 : 30)) {
        const delta = Math.min(elapsed, 65);
        clock.current += delta; previous = time;
        paint(delta);
      }
      frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      cancelAnimationFrame(frame); previous = 0;
      if (document.hidden) { hovered = -1; lastPoint = null; }
      paint();
      if (!paused && !preference.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      const nextWidth = document.documentElement.clientWidth;
      // Mobile address bars and the keyboard resize the visual viewport. Keep
      // the heart pattern anchored, rather than rebuilding/stretching it on scroll.
      const nextHeight = compact.matches ? canvas.getBoundingClientRect().height : window.innerHeight;
      if (compact.matches && width === nextWidth && height === nextHeight) return;
      width = nextWidth; height = nextHeight;
      topInset = compact.matches ? 0 : Math.max(0, header?.getBoundingClientRect().bottom ?? 0);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      columns = Math.ceil(width / PITCH_X); rows = Math.ceil(height / PITCH_Y);
      cells = Array.from({ length: columns * rows }, (_, i) => {
        const x = (i % columns) * PITCH_X + PITCH_X / 2;
        const y = Math.floor(i / columns) * PITCH_Y + FIRST_ROW_CENTER;
        return { x, y, phase: x / 920 + y / 710, heat: 0 };
      });
      hovered = -1; lastPoint = null;
      schedule();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.pointerType === "touch" || paused || preference.matches || compact.matches) return;
      const point = { x: event.clientX, y: event.clientY };
      // Trace only the cells actually crossed, including during fast pointer movement.
      if (lastPoint) {
        const distance = Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y);
        const steps = Math.min(80, Math.ceil(distance / 5));
        for (let i = 1; i <= steps; i++) {
          const index = cellAt(lastPoint.x + (point.x - lastPoint.x) * i / steps, lastPoint.y + (point.y - lastPoint.y) * i / steps);
          if (index >= 0) cells[index].heat = .95;
        }
      }
      hovered = cellAt(point.x, point.y);
      if (hovered >= 0) cells[hovered].heat = 1;
      lastPoint = point;
    };
    const leave = () => { hovered = -1; lastPoint = null; };
    const onScroll = () => {
      if (compact.matches) return;
      topInset = Math.max(0, header?.getBoundingClientRect().bottom ?? 0);
      leave();
      if (paused || preference.matches) paint();
    };
    resize();
    const layoutObserver = new ResizeObserver(resize);
    if (header) layoutObserver.observe(header);
    layoutObserver.observe(canvas);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", schedule);
    preference.addEventListener("change", schedule);
    compact.addEventListener("change", resize);
    return () => {
      cancelAnimationFrame(frame);
      layoutObserver.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointer);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", schedule);
      preference.removeEventListener("change", schedule);
      compact.removeEventListener("change", resize);
    };
  }, [paused]);
  return <canvas ref={ref} className="heart-field" aria-hidden="true" />;
}
