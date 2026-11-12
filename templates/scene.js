/*
 * Builds one scene from the payload the renderer passes in, then exposes two hooks:
 *   __mount(payload)  build the DOM, wait for fonts and images, lay everything out, pause time
 *   __seek(t, prev)   jump to `t` seconds; returns false when the picture is identical to `prev`
 * No text is ever inserted as HTML, so storyboard copy cannot break the page.
 */
(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  let animations = [];
  let counter = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function delay(node, seconds) {
    node.style.setProperty('--d', seconds.toFixed(3));
    return node;
  }

  /** Headline with a staggered word-by-word entrance. `*Starred*` words get the accent gradient. */
  function headline(text, startAt) {
    const h = el('h1', 'headline');
    let i = 0;
    text.split('*').forEach((segment, part) => {
      const emphasised = part % 2 === 1;
      segment.split(/(\s+)/).forEach((token) => {
        if (!token) return;
        if (/^\s+$/.test(token)) {
          h.append(' ');
          return;
        }
        h.append(delay(el('span', emphasised ? 'w hl' : 'w', token), startAt + i * 0.055));
        i++;
      });
    });
    return { node: h, endsAt: startAt + i * 0.055 + 0.3 };
  }

  /** Kicker, headline and subhead — the text stack most scene types share. */
  function textBlock(scene) {
    const block = el('div', 'text-block');
    let t = 0.05;
    if (scene.kicker) {
      block.append(delay(el('div', 'kicker enter', scene.kicker), t));
      t += 0.1;
    }
    if (scene.headline) {
      const h = headline(scene.headline, t);
      block.append(h.node);
      t = h.endsAt;
    }
    if (scene.subhead) {
      block.append(delay(el('p', 'subhead enter', scene.subhead), t));
      t += 0.2;
    }
    return { block, endsAt: t };
  }

  function brandLogo(brand, className) {
    const wrap = el('div', className);
    if (brand.logoUrl) {
      const img = el('img');
      img.src = brand.logoUrl;
      img.alt = '';
      wrap.append(img);
    } else if (brand.name) {
      wrap.append(el('span', 'brand-dot'), el('span', '', brand.name));
    }
    return wrap;
  }

  // ── Scene builders ────────────────────────────────────────────────────────

  const builders = {
    title(stage, scene) {
      stage.append(textBlock(scene).block);
    },

    screen(stage, scene) {
      const { block, endsAt } = textBlock(scene);
      const slot = el('div', 'device-slot');
      const device = delay(el('div', 'device'), Math.min(0.25, endsAt));
      const screen = el('div', 'device-screen');
      const wrap = el('div', 'shot-wrap');
      const img = el('img');
      img.src = scene.imageUrl;
      img.alt = '';
      wrap.append(img);
      screen.append(wrap);
      device.append(screen);
      slot.append(device);
      if (block.childNodes.length) stage.append(block);
      stage.append(slot);
      return { block, slot, device, screen, wrap, img };
    },

    bullets(stage, scene) {
      stage.append(textBlock(scene).block);
      const list = el('ul', 'bullets');
      scene.items.forEach((item, i) => {
        const li = delay(el('li'), scene.itemTimes[i] ?? 0.6 + i * 0.5);
        const tick = el('span', 'tick');
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
        svg.append(path);
        tick.append(svg);
        li.append(tick, el('span', '', item));
        list.append(li);
      });
      stage.append(list);
    },

    stat(stage, scene) {
      let t = 0.05;
      if (scene.kicker || scene.headline) {
        stage.append(delay(el('div', 'kicker enter', scene.kicker || scene.headline), t));
        t += 0.15;
      }
      const value = delay(el('div', 'stat-value', scene.value), t);
      stage.append(value);
      if (scene.label) stage.append(delay(el('div', 'stat-label enter', scene.label), t + 0.35));
      counter = makeCounter(value, scene.value, t + 0.1);
    },

    quote(stage, scene) {
      stage.append(delay(el('div', 'quote-mark enter', '“'), 0.05));
      stage.append(delay(el('blockquote', 'quote-text enter', scene.quote), 0.2));
      if (scene.author) stage.append(delay(el('div', 'quote-author enter', scene.author), 0.65));
    },

    cta(stage, scene, payload) {
      const { brand } = payload;
      let t = 0.05;
      if (brand.logoUrl || brand.name) {
        stage.append(delay(brandLogo(brand, 'cta-logo enter'), t));
        t += 0.15;
      }
      const h = headline(scene.headline, t);
      stage.append(h.node);
      t = h.endsAt;
      if (scene.subhead) {
        stage.append(delay(el('p', 'subhead enter', scene.subhead), t));
        t += 0.2;
      }
      if (scene.button) {
        stage.append(delay(el('div', 'cta-button', scene.button), t));
        t += 0.25;
      }
      const contact = [brand.url, brand.handle].filter(Boolean).join('  ·  ');
      if (contact) stage.append(delay(el('div', 'cta-url enter', contact), t));
    },
  };

  /** Count a number up from zero, keeping whatever surrounds it ("$", "%", "x", "+"). */
  function makeCounter(node, value, startAt) {
    const m = value.match(/^(.*?)(\d[\d,]*(?:\.\d+)?)(.*)$/s);
    if (!m) return null;
    const [, prefix, digits, suffix] = m;
    const target = Number(digits.replace(/,/g, ''));
    if (target < 10) return null; // "3x" ticking 0, 1, 2, 3 looks like a glitch, not a count
    const decimals = (digits.split('.')[1] ?? '').length;
    const grouped = digits.includes(',');
    const duration = 1.1;
    const format = (n) => {
      const fixed = n.toFixed(decimals);
      if (!grouped) return fixed;
      const [whole, frac] = fixed.split('.');
      return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? `.${frac}` : '');
    };
    let shown = null;
    return (t) => {
      const p = clamp((t - startAt) / duration, 0, 1);
      const text = prefix + format(target * (1 - Math.pow(1 - p, 3))) + suffix;
      if (text === shown) return false;
      node.textContent = shown = text;
      return true;
    };
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  /** Shrink text until `fits()` — long copy gets smaller type instead of spilling off the frame. */
  function fitText(fits) {
    let k = 1;
    while (k > 0.5 && !fits()) {
      k -= 0.04;
      document.documentElement.style.setProperty('--k', k.toFixed(2));
    }
  }

  function decideFrame(scene, img) {
    if (scene.frame !== 'auto') return scene.frame;
    const portrait = img.naturalHeight / img.naturalWidth > 1.25;
    // Phone screenshots top out around 1440px wide; a portrait image wider than that is a long
    // capture of a desktop page.
    return portrait && img.naturalWidth <= 1500 ? 'phone' : 'browser';
  }

  /**
   * Size the device, then work out where the screenshot starts and ends its move.
   * The move keeps the focus point inside the part of the screen that is actually in view.
   */
  function layoutScreen(payload, parts, stage) {
    const { scene, format, duration } = payload;
    const { block, slot, device, screen, wrap, img } = parts;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const u = Math.min(W, H) / 100;
    const ratio = img.naturalHeight / img.naturalWidth;
    const frame = decideFrame(scene, img);
    const focus = scene.focusX !== null && scene.focusY !== null;

    const row = format === 'landscape' || (format === 'square' && frame === 'phone');
    // In vertical video a phone is shown large and runs off one edge of the frame. Which edge
    // depends on what we are pointing at: the top of its screen (it hangs off the bottom) or the
    // bottom of it (it hangs off the top, with the text underneath).
    const bleed = frame === 'phone' && !row;
    const flip = bleed && focus && scene.focusY > 58 && scene.motion !== 'pan-down';
    document.body.classList.toggle('layout-row', row);
    document.body.classList.toggle('layout-flip', flip);
    device.classList.add(`device-${frame}`);

    const stageH = stage.clientHeight;
    fitText(() => block.offsetHeight <= (row ? stageH : stageH * 0.3) && block.scrollWidth <= block.clientWidth + 1);

    const slotW = slot.clientWidth;
    const slotH = slot.clientHeight;
    const slotTop = slot.getBoundingClientRect().top;
    const capY = (parseFloat(getComputedStyle(document.body).getPropertyValue('--cap-y')) / 100) * H;
    // Lowest point that stays clear: the captions, else the frame edge (or, in vertical video,
    // the platform's own buttons and text).
    const clearBottom = payload.showCaptions ? capY - u * 6 : H * (format === 'reel' ? 0.84 : 0.955);
    let w, h, left, top;
    let barH = 0;

    if (frame === 'phone') {
      const aspect = 19.3 / 9;
      if (row) {
        // Beside the text, as tall as the frame allows without touching the captions.
        const topEdge = H * 0.045;
        h = clearBottom - u - topEdge;
        w = h / aspect;
        top = topEdge - slotTop;
      } else {
        w = W * 0.66;
        h = w * aspect;
        top = flip ? slotH - h : 0;
      }
      left = (slotW - w) / 2;
    } else if (frame === 'browser') {
      w = row ? slotW : W * 0.92;
      barH = Math.max(26, w * 0.046);
      // In tall formats the window is taller than a real browser so the page fills more of the frame.
      h = barH + w * (row ? 0.625 : 0.75);
      if (h > slotH) {
        const s = slotH / h;
        w *= s;
        barH *= s;
        h = slotH;
      }
      left = (slotW - w) / 2;
      top = (slotH - h) * (row ? 0.5 : 0.4);
      const bar = el('div', 'browser-bar');
      bar.append(el('b'), el('b'), el('b'), el('div', 'browser-url', payload.brand.url || payload.brand.name || ''));
      device.prepend(bar);
    } else {
      const maxW = row ? slotW : W * 0.9;
      const shape = clamp(ratio, 0.45, slotH / maxW);
      w = Math.min(maxW, slotH / shape);
      h = w * shape;
      left = (slotW - w) / 2;
      top = (slotH - h) * (row ? 0.5 : 0.3);
    }

    Object.assign(device.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
    device.style.setProperty('--dw', `${w}px`);
    device.style.setProperty('--bar-h', `${barH}px`);
    if (flip) device.style.setProperty('--d', '0.05');

    // The window onto the screenshot that the viewer can actually see (screen coordinates).
    const sw = screen.clientWidth;
    const sh = screen.clientHeight;
    const screenTop = screen.getBoundingClientRect().top;
    let v0 = 0;
    let v1 = sh;
    if (bleed) {
      if (flip) v0 = Math.max(0, H * 0.1 - screenTop);
      else v1 = Math.min(sh, clearBottom - screenTop);
    }

    wrap.style.width = `${sw}px`;
    const imgH = sw * ratio;
    const cover = Math.max(1, sh / imgH); // never show empty screen around a short image
    const view = (cx, cy, z) => {
      const tx = clamp(sw / 2 - cx * z, sw - sw * z, 0);
      const ty = clamp((v0 + v1) / 2 - cy * z, sh - imgH * z, 0);
      return `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${z.toFixed(4)})`;
    };

    const fx = focus ? (scene.focusX / 100) * sw : sw / 2;
    const fy = focus ? (scene.focusY / 100) * imgH : (v0 + v1) / 2 / cover;
    const scrollable = imgH * cover - sh;
    let motion = scene.motion;
    if (motion === 'auto') motion = scrollable > (v1 - v0) * 0.5 ? 'pan-down' : 'zoom-in';
    if (motion === 'pan-down' && scrollable < (v1 - v0) * 0.12) motion = 'zoom-in';

    let from, to;
    if (motion === 'pan-down') {
      const startY = focus ? clamp(fy * cover - (v1 - v0) * 0.25, 0, scrollable) : 0;
      const distance = Math.min(scrollable - startY, (v1 - v0) * 0.42 * duration);
      from = `translate(${((sw - sw * cover) / 2).toFixed(2)}px, ${(-startY).toFixed(2)}px) scale(${cover.toFixed(4)})`;
      to = `translate(${((sw - sw * cover) / 2).toFixed(2)}px, ${(-startY - distance).toFixed(2)}px) scale(${cover.toFixed(4)})`;
    } else {
      // Desktop screenshots squeezed into a vertical frame need a stronger push-in to be readable.
      // Phones already fill the frame, so they only drift; desktop pages squeezed into a tall frame
      // need a real push-in before their text is readable.
      const push = frame === 'phone' ? (focus ? 1.1 : 1.06) : !focus ? 1.1 : row ? 1.45 : 1.9;
      const wide = view(sw / 2, focus ? fy : (v0 + v1) / 2 / cover, cover);
      const tight = view(fx, fy, cover * push);
      if (motion === 'static') from = to = focus ? view(fx, fy, cover * 1.2) : wide;
      else if (motion === 'zoom-out') [from, to] = [tight, wide];
      else [from, to] = [wide, tight];
    }
    wrap.style.setProperty('--shot-from', from);
    wrap.style.setProperty('--shot-to', to);

    if (focus && scene.highlight) {
      const ring = el('div', 'ring');
      ring.style.left = `${scene.focusX}%`;
      ring.style.top = `${scene.focusY}%`;
      ring.style.setProperty('--ring', `${sw * 0.2}px`);
      wrap.append(ring);
    }
  }

  function buildCaptions(payload) {
    const layer = el('div', 'captions');
    for (const chunk of payload.captions) {
      const cap = el('div', 'cap');
      cap.style.setProperty('--s', chunk.start.toFixed(3));
      cap.style.setProperty('--e', chunk.hideAt.toFixed(3));
      for (const word of chunk.words) {
        const span = el('span', 'cw', word.text);
        span.style.setProperty('--s', word.start.toFixed(3));
        span.style.setProperty('--e', word.until.toFixed(3));
        cap.append(span);
      }
      layer.append(cap);
    }
    return layer;
  }

  // ── Hooks used by the renderer ────────────────────────────────────────────

  window.__mount = async (payload) => {
    const { scene, brand } = payload;
    const root = document.documentElement.style;
    for (const [name, value] of Object.entries(brand.colors)) root.setProperty(`--${name}`, value);
    root.setProperty('--font-heading', `'${brand.fonts.heading}'`);
    root.setProperty('--font-body', `'${brand.fonts.body}'`);
    root.setProperty('--dur', payload.duration);
    root.setProperty('--t0', payload.start);
    root.setProperty('--p0', payload.start / payload.total);
    root.setProperty('--p1', (payload.start + payload.duration) / payload.total);

    const fontStyle = el('style');
    fontStyle.textContent = payload.fontCss;
    document.head.append(fontStyle);

    // While measuring, animations are off so entrance offsets cannot skew any measurement.
    const freeze = el('style');
    freeze.textContent = '*, *::before, *::after { animation: none !important; }';
    document.head.append(freeze);

    const body = document.body;
    body.className = `fmt-${payload.format} type-${scene.type}`;
    body.classList.toggle('no-ambient', !brand.ambientMotion);
    body.classList.toggle('no-captions', !payload.showCaptions);

    const bg = el('div', 'bg');
    bg.append(el('div', 'bg-blob b1'), el('div', 'bg-blob b2'), el('div', 'bg-grid'));
    const stage = el('div', 'stage');
    body.append(bg, stage);

    const parts = builders[scene.type](stage, scene, payload);

    if (brand.logoUrl || brand.name) body.append(brandLogo(brand, 'brandmark'));
    if (brand.progressBar) {
      const bar = el('div', 'progress');
      bar.append(el('i'));
      body.append(bar);
    }
    if (payload.showCaptions) body.append(buildCaptions(payload));

    // Fonts load lazily, so lay the page out once before waiting on them.
    void body.offsetHeight;
    await Promise.all([
      document.fonts.load(`800 40px '${brand.fonts.heading}'`),
      document.fonts.load(`600 40px '${brand.fonts.body}'`),
    ]).catch(() => {});
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((img) =>
        img.decode().catch(() => {
          throw new Error(`Could not load image: ${img.src}`);
        }),
      ),
    );

    if (scene.type === 'screen') {
      layoutScreen(payload, parts, stage);
    } else {
      fitText(
        () =>
          stage.scrollHeight <= stage.clientHeight + 1 &&
          [...stage.children].every((child) => child.scrollWidth <= stage.clientWidth + 1),
      );
    }
    for (const cap of document.querySelectorAll('.cap')) {
      const max = window.innerWidth * 0.9;
      if (cap.offsetWidth > max) cap.style.fontSize = `${(parseFloat(getComputedStyle(cap).fontSize) * max) / cap.offsetWidth}px`;
    }

    freeze.remove();
    animations = document.getAnimations();
    for (const animation of animations) animation.pause();
    return { animations: animations.length };
  };

  window.__seek = (t, prev) => {
    const ms = t * 1000;
    const prevMs = prev * 1000;
    let changed = prev < 0;
    for (const animation of animations) {
      animation.currentTime = ms;
      if (changed) continue;
      // The frame differs from the last one if any animation was running at some point in between.
      const timing = animation.effect.getComputedTiming();
      if (ms >= timing.delay - 1 && prevMs <= timing.endTime + 1) changed = true;
    }
    if (counter && counter(t)) changed = true;
    return changed;
  };
})();
