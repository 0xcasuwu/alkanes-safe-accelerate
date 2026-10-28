// site/src/setup.js → docs/setup.js: the setup guide's Copy buttons (the page's CSP allows no inline script).
for (const b of document.querySelectorAll('button[data-copy]')) {
  b.addEventListener('click', async () => {
    const text = document.getElementById(b.dataset.copy).textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select it and copy';
    }
    setTimeout(() => { b.textContent = 'Copy'; }, 2000);
  });
}
