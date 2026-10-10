// Landing Saku. Semua perilaku bersifat tambahan: tanpa JS, tautan tetap berfungsi.
(function () {
  'use strict';
  var doc = document;
  doc.documentElement.classList.add('js');

  // ---------- alamat dashboard dan pemeriksaan koneksi lokal ----------
  var meta = doc.querySelector('meta[name="saku-local-origin"]');
  var LOCAL = (meta && meta.content) || 'http://127.0.0.1:8000';
  var servedLocally = ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) !== -1;
  var dashboardUrl = (servedLocally ? location.origin : LOCAL) + '/dashboard';

  var openers = doc.querySelectorAll('[data-open-dashboard]');
  var dialog = doc.getElementById('localDialog');
  var statusEl = doc.getElementById('localStatus');
  var retryBtn = doc.getElementById('retryBtn');
  var lastTrigger = null;

  Array.prototype.forEach.call(openers, function (a) { a.setAttribute('href', dashboardUrl); });

  // Bila halaman ini disajikan oleh Saku sendiri, dashboard pasti tersedia dan tautan biasa sudah cukup.
  // Bila dibuka dari tempat lain (misalnya berkas HTML), periksa dulu apakah Saku berjalan di komputer ini.
  function probe() {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 2500);
    // no-cors: respons buram sudah cukup untuk tahu bahwa server menjawab; yang gagal tersambung akan menolak.
    return fetch(LOCAL + '/api/v1/health', { mode: 'no-cors', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function () { clearTimeout(timer); return true; })
      .catch(function () { clearTimeout(timer); return false; });
  }

  function setBusy(el, busy) {
    if (!el) return;
    if (busy) {
      el.setAttribute('aria-disabled', 'true');
      el.setAttribute('aria-busy', 'true');
      el.dataset.label = el.textContent;
      el.textContent = 'Memeriksa Saku...';
    } else {
      el.removeAttribute('aria-disabled');
      el.removeAttribute('aria-busy');
      if (el.dataset.label) el.textContent = el.dataset.label;
    }
  }

  function showDialog(trigger) {
    lastTrigger = trigger;
    doc.getElementById('localAddr').textContent = LOCAL;
    statusEl.textContent = '';
    if (!dialog.open) dialog.showModal();
    retryBtn.focus();
  }

  function onOpen(e) {
    if (servedLocally || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    var el = e.currentTarget;
    if (el.getAttribute('aria-disabled') === 'true') return;
    setBusy(el, true);
    probe().then(function (up) {
      setBusy(el, false);
      if (up) location.assign(dashboardUrl);
      else showDialog(el);
    });
  }
  if (!servedLocally) {
    Array.prototype.forEach.call(openers, function (a) { a.addEventListener('click', onOpen); });
  }

  retryBtn.addEventListener('click', function () {
    retryBtn.disabled = true;
    statusEl.textContent = 'Memeriksa...';
    probe().then(function (up) {
      retryBtn.disabled = false;
      if (up) {
        statusEl.textContent = 'Saku terdeteksi. Membuka dashboard...';
        location.assign(dashboardUrl);
      } else {
        statusEl.textContent = 'Belum ada respons dari ' + LOCAL + '. Pastikan terminal yang menjalankan Saku masih terbuka.';
      }
    });
  });
  dialog.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]') || e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', function () {
    if (lastTrigger && doc.contains(lastTrigger)) lastTrigger.focus();
  });

  // ---------- alur kerja: garis penghubung tergambar sekali saat terlihat ----------
  var flow = doc.querySelector('.flow');
  if (flow) {
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { flow.classList.add('in'); io.disconnect(); }
      }, { threshold: 0.3 });
      io.observe(flow);
    } else {
      flow.classList.add('in');
    }
  }

  // ---------- salin perintah ----------
  var copyBtn = doc.getElementById('copyBtn');
  var cmd = doc.getElementById('startCmd');
  var copyStatus = doc.getElementById('copyStatus');
  var resetTimer;

  function selectCommand() {
    var range = doc.createRange();
    range.selectNodeContents(cmd);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function copied() {
    copyBtn.textContent = 'Tersalin';
    copyStatus.textContent = 'Perintah tersalin ke clipboard.';
    clearTimeout(resetTimer);
    resetTimer = setTimeout(function () { copyBtn.textContent = 'Salin'; copyStatus.textContent = ''; }, 2200);
  }
  function manual() {
    selectCommand();
    copyStatus.textContent = 'Tidak bisa menyalin otomatis. Teksnya sudah dipilih, tekan Ctrl+C.';
  }
  if (copyBtn && cmd) {
    copyBtn.hidden = false;
    copyBtn.addEventListener('click', function () {
      var text = cmd.textContent.trim();
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(copied, manual);
      else manual();
    });
  }
})();
