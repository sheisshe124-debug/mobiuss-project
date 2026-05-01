/* =========================================================
   Möbiuss project — portfolio interactions
   1. pixel-art möbius (lemniscate of Gerono → grid pixels)
   2. mouse repel scatter physics (springs back to home)
   3. reveal on scroll
   ========================================================= */

(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ---------- 1. Möbius band particle generator ---------- */
  // 곡선(lemniscate)의 centerline을 따라 perpendicular sweep으로 띠 두께를 깐다.
  // - 띠 폭은 cos(2t)로 변화: 로브 정점=두껍고, 교차점=얇음 (뫼비우스 띠 트위스트 느낌)
  // - 입자 크기는 (중심↔가장자리 거리) + 랜덤 jitter로 다양화
  function buildPixelMobius(host, opts = {}) {
    if (!host) return null;

    const cols    = opts.cols    || 120;
    const rows    = opts.rows    || 60;
    const px      = opts.px      || 6;
    const yScale  = opts.yScale  || 0.55;
    const fill    = opts.fill    || '#e54a23';
    const baseR   = opts.radius  || 1.5;
    const wMin    = opts.thickMin ?? 1;   // 가장 얇은 곳 (반폭, 셀 단위)
    const wMax    = opts.thickMax ?? 7;   // 가장 두꺼운 곳
    const sStep   = opts.sweepStep || 0.4;

    const a  = (cols / 2) - 3;
    const cx = cols / 2;
    const cy = rows / 2;
    const w  = cols * px;
    const h  = rows * px;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // 셀별로 가장 작은 edgeNorm(중심 0, 가장자리 1) 만 보존
    const cells = new Map();
    const steps = 2400;

    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;

      // centerline (lemniscate of Gerono)
      const lx = a * Math.cos(t) + cx;
      const ly = a * Math.sin(t) * Math.cos(t) * yScale * 2 + cy;

      // 접선 (도함수)
      const dxdt = -a * Math.sin(t);
      const dydt = a * Math.cos(2 * t) * yScale * 2; // d/dt[sin·cos] = cos(2t)
      const tlen = Math.hypot(dxdt, dydt) || 1;

      // 법선 (단위 벡터)
      const nx = -dydt / tlen;
      const ny =  dxdt / tlen;

      // 폭 변화: cos(2t) → 로브 정점에서 두껍고 교차점에서 얇음
      const wphase = 0.5 + 0.5 * Math.cos(2 * t);
      const halfWidth = wMin + (wMax - wMin) * wphase;

      // 법선 방향으로 sweep
      for (let s = -halfWidth; s <= halfWidth; s += sStep) {
        const sx = Math.round(lx + s * nx);
        const sy = Math.round(ly + s * ny);
        const key = sx + ',' + sy;
        const norm = Math.abs(s) / Math.max(halfWidth, 0.5); // 0=중심, 1=가장자리
        if (!cells.has(key) || cells.get(key) > norm) {
          cells.set(key, norm);
        }
      }
    }

    // 입자 발사 — 가장자리 가까울수록 작고, 랜덤 jitter
    const pixels = [];
    cells.forEach((edgeNorm, key) => {
      const [x, y] = key.split(',').map(Number);
      if (x < 0 || y < 0 || x >= cols || y >= rows) return;

      const cxC = x * px + px / 2;
      const cyC = y * px + px / 2;

      // 사이즈 결정
      // - 중심(edgeNorm≈0)일수록 큼
      // - 가장자리(edgeNorm≈1)일수록 작아짐
      // - 랜덤으로 한 번 더 흔들어서 다이나믹하게
      const edgeFactor = 1 - 0.6 * edgeNorm;          // 1.0 → 0.4
      const jitter     = 0.55 + Math.random() * 0.75;  // 0.55 ~ 1.30
      let r = baseR * edgeFactor * jitter;
      // 살짝 작은 입자도 항상 섞이도록 30% 확률로 한 번 더 줄임
      if (Math.random() < 0.3) r *= 0.55;
      // clamp
      r = Math.max(0.25, Math.min(baseR * 1.25, r));

      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', cxC);
      c.setAttribute('cy', cyC);
      c.setAttribute('r',  r.toFixed(2));
      c.setAttribute('fill', fill);
      svg.appendChild(c);
      pixels.push({ el: c, hx: cxC, hy: cyC });
    });

    host.innerHTML = '';
    host.appendChild(svg);
    return { svg, pixels, cols, rows, px, w, h };
  }

  /* ---------- 2. Scatter physics field ---------- */
  class PixelField {
    constructor(svg, pixels, opts = {}) {
      this.svg     = svg;
      this.pixels  = pixels.map(p => ({
        el: p.el, hx: p.hx, hy: p.hy,
        x: p.hx, y: p.hy, vx: 0, vy: 0
      }));
      this.r       = opts.repelRadius   || 90;
      this.strength= opts.repelStrength || 4.5;
      this.k       = opts.springK       || 0.045;
      this.damp    = opts.damping       || 0.86;
      this.mx      = -1e6;
      this.my      = -1e6;

      this._tick = this._tick.bind(this);
      requestAnimationFrame(this._tick);
    }

    setMouseFromEvent(e) {
      const rect = this.svg.getBoundingClientRect();
      if (rect.width === 0) return;
      const vb = this.svg.viewBox.baseVal;
      // svg might have empty space due to preserveAspectRatio meet — compute the rendered area
      const scale = Math.min(rect.width / vb.width, rect.height / vb.height);
      const renderedW = vb.width * scale;
      const renderedH = vb.height * scale;
      const offsetX = (rect.width  - renderedW) / 2;
      const offsetY = (rect.height - renderedH) / 2;
      this.mx = (e.clientX - rect.left - offsetX) / scale;
      this.my = (e.clientY - rect.top  - offsetY) / scale;
    }

    clearMouse() { this.mx = -1e6; this.my = -1e6; }

    _tick() {
      const r = this.r;
      const r2 = r * r;
      const k = this.k;
      const d = this.damp;
      const s = this.strength;
      const mx = this.mx;
      const my = this.my;
      const len = this.pixels.length;

      for (let i = 0; i < len; i++) {
        const p = this.pixels[i];

        // spring toward home
        let fx = (p.hx - p.x) * k;
        let fy = (p.hy - p.y) * k;

        // repulsion from mouse
        const dx = p.x - mx;
        const dy = p.y - my;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < r2 && dist2 > 0.5) {
          const dist = Math.sqrt(dist2);
          const fall = 1 - dist / r;            // 0..1
          const force = fall * fall * s;        // squared falloff
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        }

        p.vx = (p.vx + fx) * d;
        p.vy = (p.vy + fy) * d;
        p.x  += p.vx;
        p.y  += p.vy;

        const tx = (p.x - p.hx).toFixed(1);
        const ty = (p.y - p.hy).toFixed(1);
        p.el.setAttribute('transform', `translate(${tx} ${ty})`);
      }
      requestAnimationFrame(this._tick);
    }
  }

  /* ---------- build & wire up ---------- */
  // hero möbius (풀스크린 배경)
  // 진짜 뫼비우스 띠 — 폭이 변함(로브 두껍, 교차점 얇음) + 입자 크기 다이나믹
  const heroBuild = buildPixelMobius(document.getElementById('pixelMobiusBg'), {
    cols: 120, rows: 60, px: 6,
    thickMin: 1, thickMax: 7,           // 띠 폭 변화 1~7 셀(반폭)
    radius: 1.5, yScale: 0.55, fill: '#e54a23'
  });

  if (heroBuild) {
    const field = new PixelField(heroBuild.svg, heroBuild.pixels, {
      // 확 흩뿌려졌다가 천천히 돌아오는 느낌:
      // - repelStrength ↑ : 강한 초기 푸시
      // - springK ↓        : 약한 복귀 스프링 (느린 귀환)
      // - damping ↑        : 마찰 적게 (운동 유지, 둥실거림)
      repelRadius: 120, repelStrength: 9.0, springK: 0.010, damping: 0.93
    });

    const hero = document.querySelector('.hero');
    if (hero) {
      hero.addEventListener('mousemove', (e) => field.setMouseFromEvent(e));
      hero.addEventListener('mouseleave', () => field.clearMouse());

      hero.addEventListener('touchmove', (e) => {
        if (e.touches.length) field.setMouseFromEvent(e.touches[0]);
      }, { passive: true });
      hero.addEventListener('touchend', () => field.clearMouse());
    }
  }

  // 네비 미니 모비우스 (정적, 진회색)
  buildPixelMobius(document.getElementById('navMobius'), {
    cols: 28, rows: 14, px: 3,
    thickMin: 0.4, thickMax: 1.6,
    radius: 0.9, yScale: 0.55, fill: '#e54a23'
  });

  /* ---------- 3. Reveal on scroll ---------- */
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const revealTargets = document.querySelectorAll(
    '.about-quote, .about-body p, .section-title, .member-block, .work, .link-card'
  );
  revealTargets.forEach(el => el.classList.add('reveal'));

  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const parent = entry.target.parentElement;
          if (parent && parent.classList.contains('works-grid')) {
            const idx = [...parent.children].indexOf(entry.target);
            entry.target.style.transitionDelay = (idx * 0.07) + 's';
          }
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    revealTargets.forEach(el => io.observe(el));
  } else {
    revealTargets.forEach(el => el.classList.add('in'));
  }

  /* ---------- 4. scroll cue fade ---------- */
  const cue = document.querySelector('.scroll-cue');
  window.addEventListener('scroll', () => {
    if (!cue) return;
    cue.style.transition = 'opacity .4s ease';
    cue.style.opacity = window.scrollY > 80 ? '0' : '1';
  }, { passive: true });

})();
