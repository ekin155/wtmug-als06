/* ============================================================
   Market Barkod Okuyucu PWA
   - BarcodeDetector ile cihaz üzerinde okuma
   - Tekli Sorgu / Sepet Modu
   - Elle barkod girişi
   - 1.5 sn aynı barkod koruması
   ============================================================ */

/* ---------- Ürün veritabanı (JSON) ---------- */
const PRODUCTS_JSON = `[
  {
    "barcode": "8690504010010",
    "name": "Tam Yağlı Süt 1 L",
    "brand": "Sütaş",
    "category": "Gıda",
    "price": 32.50,
    "amount": "1 Litre"
  },
  {
    "barcode": "8690504010027",
    "name": "Kavrulmuş Fındık 250 g",
    "brand": "Tadım",
    "category": "Gıda",
    "price": 89.90,
    "amount": "250 Gram"
  },
  {
    "barcode": "8690504010034",
    "name": "Bulaşık Deterjanı 750 ml",
    "brand": "Fairy",
    "category": "Temizlik",
    "price": 64.75,
    "amount": "750 Mililitre"
  },
  {
    "barcode": "8690504010041",
    "name": "Şampuan 400 ml",
    "brand": "Elseve",
    "category": "Kozmetik",
    "price": 78.00,
    "amount": "400 Mililitre"
  },
  {
    "barcode": "8690504010058",
    "name": "Tam Buğday Ekmeği 500 g",
    "brand": "Uno",
    "category": "Gıda",
    "price": 22.00,
    "amount": "500 Gram"
  },
  {
    "barcode": "8690504010065",
    "name": "Diş Macunu 75 ml",
    "brand": "Colgate",
    "category": "Kozmetik",
    "price": 41.25,
    "amount": "75 Mililitre"
  }
]`;

const PRODUCTS = JSON.parse(PRODUCTS_JSON);
const PRODUCT_MAP = new Map(PRODUCTS.map(p => [p.barcode, p]));

/* ---------- Uygulama durumu ---------- */
const state = {
  mode: 'single',           // 'single' | 'cart'
  cart: [],                 // [{barcode, qty, product}]
  lastScans: new Map(),     // barcode -> timestamp (1.5 sn koruması)
  stream: null,
  detector: null,
  scanning: false,
  rafId: null,
  track: null,
};

const SCAN_COOLDOWN_MS = 1500;

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const els = {
  tabSingle: $('tabSingle'),
  tabCart: $('tabCart'),
  video: $('video'),
  viewer: $('viewer'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnTorch: $('btnTorch'),
  manualInput: $('manualInput'),
  btnManual: $('btnManual'),
  singleView: $('singleView'),
  cartView: $('cartView'),
  singleContent: $('singleContent'),
  cartList: $('cartList'),
  cartEmpty: $('cartEmpty'),
  cartBadge: $('cartBadge'),
  cartSummary: $('cartSummary'),
  cartTotal: $('cartTotal'),
  cartCount: $('cartCount'),
  btnClearCart: $('btnClearCart'),
  toast: $('toast'),
  netStatus: $('netStatus'),
};

/* ---------- Yardımcılar ---------- */
const fmtTL = n => n.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' });
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));

let toastTimer = null;
function toast(msg, type = '') {
  els.toast.textContent = msg;
  els.toast.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.className = 'toast ' + type; }, 2200);
}

/* ---------- BarcodeDetector kontrolü ---------- */
async function ensureDetector() {
  if (state.detector) return true;
  if (!('BarcodeDetector' in window)) {
    toast('Bu tarayıcı BarcodeDetector API desteklemiyor. Elle giriş kullanabilirsiniz.', 'error');
    return false;
  }
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    // Klasik barkod formatları (QR değil)
    const wanted = ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf'];
    const formats = wanted.filter(f => supported.includes(f));
    if (!formats.length) {
      toast('Desteklenen klasik barkod formatı bulunamadı.', 'error');
      return false;
    }
    state.detector = new window.BarcodeDetector({ formats });
    return true;
  } catch (e) {
    console.error(e);
    toast('Barkod okuyucu başlatılamadı.', 'error');
    return false;
  }
}

/* ---------- Kamera kontrolü ---------- */
async function startCamera() {
  if (state.scanning) return;

  const ok = await ensureDetector();
  if (!ok) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Kamera erişimi bu tarayıcıda desteklenmiyor.', 'error');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
    state.stream = stream;
    state.track = stream.getVideoTracks()[0];
    els.video.srcObject = stream;
    await els.video.play();

    // Fener kontrolü
    const caps = state.track.getCapabilities?.() || {};
    els.btnTorch.classList.toggle('hidden', !caps.torch);

    state.scanning = true;
    els.btnStart.disabled = true;
    els.btnStop.disabled = false;

    detectLoop();
  } catch (err) {
    console.error(err);
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
      toast('Kamera izni reddedildi. Lütfen tarayıcı ayarlarından izin verin veya elle barkod girin.', 'error');
    } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      toast('Cihazda uygun kamera bulunamadı.', 'error');
    } else if (err.name === 'NotReadableError') {
      toast('Kamera başka bir uygulama tarafından kullanılıyor olabilir.', 'error');
    } else {
      toast('Kamera başlatılamadı: ' + (err.message || err.name), 'error');
    }
  }
}

function stopCamera() {
  state.scanning = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
  }
  state.stream = null;
  state.track = null;
  els.video.srcObject = null;
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  els.btnTorch.classList.add('hidden');
}

/* ---------- Algılama döngüsü ---------- */
async function detectLoop() {
  if (!state.scanning) return;
  if (els.video.readyState >= 2 && state.detector) {
    try {
      const codes = await state.detector.detect(els.video);
      if (codes && codes.length) {
        // En büyük/kalın olanı tercih et
        const best = codes[0];
        handleBarcode(best.rawValue, 'kamera');
      }
    } catch (e) {
      // Tek karelik hata döngüyü bozmasın
      console.warn('detect hatası:', e);
    }
  }
  state.rafId = requestAnimationFrame(detectLoop);
}

/* ---------- Barkod işleme ---------- */
function handleBarcode(raw, source = 'kamera') {
  const code = String(raw || '').trim();
  if (!code) return;

  // 1.5 sn aynı barkod koruması
  const now = Date.now();
  const last = state.lastScans.get(code) || 0;
  if (now - last < SCAN_COOLDOWN_MS) return;
  state.lastScans.set(code, now);

  // Eski kayıtları temizle
  for (const [k, t] of state.lastScans) {
    if (now - t > SCAN_COOLDOWN_MS * 4) state.lastScans.delete(k);
  }

  const product = PRODUCT_MAP.get(code);
  if (!product) {
    toast('Ürün bulunamadı.', 'error');
    if (navigator.vibrate) navigator.vibrate(120);
    return;
  }

  if (navigator.vibrate) navigator.vibrate(40);

  if (state.mode === 'single') {
    renderSingleProduct(product);
  } else {
    addToCart(product);
  }
}

/* ---------- Tekli mod ---------- */
function renderSingleProduct(p) {
  els.singleContent.classList.remove('empty');
  els.singleContent.innerHTML = `
    <div class="product-title">${escapeHtml(p.name)}</div>
    <div class="product-brand">${escapeHtml(p.brand)} · ${escapeHtml(p.category)}</div>
    <div class="product-row"><span class="k">Barkod</span><span class="v">${escapeHtml(p.barcode)}</span></div>
    <div class="product-row"><span class="k">Miktar</span><span class="v">${escapeHtml(p.amount)}</span></div>
    <div class="product-row"><span class="k">Fiyat</span><span class="v price-tag">${fmtTL(p.price)}</span></div>
  `;
}

/* ---------- Sepet ---------- */
function addToCart(product) {
  const existing = state.cart.find(i => i.barcode === product.barcode);
  if (existing) {
    existing.qty += 1;
  } else {
    state.cart.push({ barcode: product.barcode, qty: 1, product });
  }
  renderCart();
  toast(`${product.name} sepete eklendi`);
}

function removeFromCart(barcode) {
  state.cart = state.cart.filter(i => i.barcode !== barcode);
  renderCart();
}

function clearCart() {
  state.cart = [];
  renderCart();
  toast('Sepet temizlendi');
}

function cartTotal() {
  return state.cart.reduce((s, i) => s + i.product.price * i.qty, 0);
}
function cartCount() {
  return state.cart.reduce((s, i) => s + i.qty, 0);
}

function renderCart() {
  const items = state.cart;
  const total = cartTotal();
  const count = cartCount();

  els.cartBadge.textContent = count;
  els.cartCount.textContent = count + ' ürün';
  els.cartTotal.textContent = fmtTL(total);
  els.cartSummary.classList.toggle('hidden', items.length === 0);

  if (!items.length) {
    els.cartList.innerHTML = '<li class="empty" id="cartEmpty">Sepet boş. Ürünleri okutun.</li>';
    return;
  }

  els.cartList.innerHTML = items.map(i => `
    <li>
      <div>
        <div class="name">${escapeHtml(i.product.name)}</div>
        <div class="meta">${escapeHtml(i.product.brand)} · ${escapeHtml(i.product.amount)} · ${i.qty} adet</div>
      </div>
      <div class="right">
        <span class="price">${fmtTL(i.product.price * i.qty)}</span>
        <button class="rm" data-bc="${escapeHtml(i.barcode)}">Sil</button>
      </div>
    </li>
  `).join('');

  els.cartList.querySelectorAll('.rm').forEach(btn => {
    btn.addEventListener('click', () => removeFromCart(btn.dataset.bc));
  });
}

/* ---------- Mod değiştirme ---------- */
function setMode(mode) {
  state.mode = mode;
  els.tabSingle.classList.toggle('active', mode === 'single');
  els.tabCart.classList.toggle('active', mode === 'cart');
  els.singleView.classList.toggle('hidden', mode !== 'single');
  els.cartView.classList.toggle('hidden', mode !== 'cart');
  els.cartSummary.classList.toggle('hidden', !(mode === 'cart' && state.cart.length > 0));
}

/* ---------- Olaylar ---------- */
els.tabSingle.addEventListener('click', () => setMode('single'));
els.tabCart.addEventListener('click', () => setMode('cart'));
els.btnStart.addEventListener('click', startCamera);
els.btnStop.addEventListener('click', stopCamera);
els.btnClearCart.addEventListener('click', clearCart);
els.btnManual.addEventListener('click', () => {
  const v = els.manualInput.value.trim();
  if (!v) { toast('Barkod numarası girin.', 'warn'); return; }
  handleBarcode(v, 'manuel');
  els.manualInput.value = '';
});
els.manualInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.btnManual.click();
});
els.btnTorch.addEventListener('click', async () => {
  if (!state.track) return;
  try {
    const on = state.track.getSettings?.().torch;
    await state.track.applyConstraints({ advanced: [{ torch: !on }] });
  } catch (e) {
    toast('Fener açılamadı.', 'warn');
  }
});

/* Sayfa kapanırken kamerayı kapat */
window.addEventListener('pagehide', stopCamera);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.scanning) {
    // Arka planda gereksiz pil tüketimini azalt
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
  } else if (!document.hidden && state.scanning && !state.rafId) {
    detectLoop();
  }
});

/* Çevrimiçi/çevrimdışı göstergesi */
function updateNet() {
  const online = navigator.onLine;
  els.netStatus.textContent = online ? '●' : '○';
  els.netStatus.style.color = online ? '#b7f5c9' : '#ffd8a8';
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);
updateNet();

/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW kayıt hatası:', err));
  });
}

/* ---------- Başlangıç ---------- */
renderCart();
setMode('single');
const urunler=[
{ 
barkod:"8680632041827",
isim:"toz kahve",
marka:"nescafe",
kategori:"gıda"
fiyat:15,
birim:"TL",
miktar:"10 gram"
}

{
    barkod:"4015000090940",
isim:"stick yapıştırıcı",
marka:"priit",
kategori:"kırtasiye"
fiyat:80,
birim:"TL",
miktar:"43 gram"
}

{
    barkod:"8690857011964",
isim:"10 numara zımba teli",
marka:"3A",
kategori:"kırtasiye"
fiyat:35,
birim:"TL",
miktar:"1000 adet"
}

];




