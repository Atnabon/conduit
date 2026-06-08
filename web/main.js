// conduit landing page — progressive enhancement only.
// Reveal-on-scroll via IntersectionObserver. Respects reduced-motion.

(() => {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reveals = document.querySelectorAll('.reveal');

  if (reduced || !('IntersectionObserver' in window)) {
    reveals.forEach((el) => el.classList.add('in'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        // Stagger siblings for a calmer cascade.
        const peers = Array.from(el.parentElement?.children ?? []);
        const delay = Math.min(peers.indexOf(el), 4) * 70;
        setTimeout(() => el.classList.add('in'), delay);
        observer.unobserve(el);
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.1 },
  );

  reveals.forEach((el) => observer.observe(el));
})();
