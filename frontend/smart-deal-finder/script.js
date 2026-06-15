// ===== Configuration =====
// Auto-detect API backend: local dev vs tunnel/prod
const API_BASE = (() => {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  return isLocal ? "http://127.0.0.1:8000" : "https://api.yourdomain.com";
})();

// ===== Mobile Detection & Performance =====
const isMobile =
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  ) || window.innerWidth <= 768;
const isLowEndDevice =
  navigator.hardwareConcurrency <= 4 || navigator.deviceMemory <= 4;

// ===== API Request Manager (Prevent loops & cache) =====
const APIManager = {
  cache: new Map(),
  pendingRequests: new Map(),
  CACHE_TTL: 5 * 60 * 1000, // 5 minutes cache

  // Get cached response or null
  getCache(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  },

  // Set cache
  setCache(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
    // Limit cache size
    if (this.cache.size > 50) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  },

  // Fetch with deduplication, caching, and abort support
  async fetch(url, options = {}) {
    const isGet = !options.method || options.method === "GET";
    const cacheKey = url + JSON.stringify(options);

    // Only cache GET requests
    if (isGet) {
      const cached = this.getCache(cacheKey);
      if (cached) return cached;

      // Check if request already pending
      if (this.pendingRequests.has(cacheKey)) {
        return this.pendingRequests.get(cacheKey);
      }
    }

    // Create new request
    const requestPromise = (async () => {
      try {
        // Combine external signal with 30s timeout
        let signal;
        if (options.signal) {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 30000);
          options.signal.addEventListener("abort", () => {
            clearTimeout(t);
            ctrl.abort();
          });
          signal = ctrl.signal;
        } else {
          signal = AbortSignal.timeout(30000);
        }

        const fetchOptions = {
          ...options,
          signal,
          cache: "no-store",
        };
        // Add JSON headers for requests with a body
        if (options.body && typeof options.body === "string") {
          fetchOptions.headers = {
            "Content-Type": "application/json",
            ...(options.headers || {}),
          };
        }

        const response = await fetch(url, fetchOptions);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (isGet) this.setCache(cacheKey, data);
        return data;
      } finally {
        this.pendingRequests.delete(cacheKey);
      }
    })();

    this.pendingRequests.set(cacheKey, requestPromise);
    return requestPromise;
  },

  // Clear all cache
  clearCache() {
    this.cache.clear();
  },
};

// ===== Debounce utility =====
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ===== Guest Search Limit =====
const GUEST_SEARCH_LIMIT = 3;
const STORAGE_KEY_SEARCHES = "smartdeals_guest_searches";
const STORAGE_KEY_DATE = "smartdeals_search_date";

// Track guest searches
const GuestLimit = {
  getSearchCount() {
    try {
      const today = new Date().toDateString();
      const storedDate = localStorage.getItem(STORAGE_KEY_DATE);

      // Reset count if it's a new day
      if (storedDate !== today) {
        localStorage.setItem(STORAGE_KEY_DATE, today);
        localStorage.setItem(STORAGE_KEY_SEARCHES, "0");
        return 0;
      }

      return parseInt(localStorage.getItem(STORAGE_KEY_SEARCHES) || "0");
    } catch (e) {
      return 0; // localStorage may be blocked
    }
  },

  incrementCount() {
    try {
      const count = this.getSearchCount() + 1;
      localStorage.setItem(STORAGE_KEY_SEARCHES, count.toString());
      return count;
    } catch (e) {
      return 0;
    }
  },

  canSearch() {
    // Logged in users have unlimited searches
    if (typeof currentUser !== "undefined" && currentUser) return true;
    return this.getSearchCount() < GUEST_SEARCH_LIMIT;
  },

  getRemainingSearches() {
    if (typeof currentUser !== "undefined" && currentUser) return Infinity;
    return Math.max(0, GUEST_SEARCH_LIMIT - this.getSearchCount());
  },

  showLoginPrompt() {
    // Remove existing popup if any
    const existing = document.querySelector(".login-prompt-overlay");
    if (existing) existing.remove();

    const popup = document.createElement("div");
    popup.className = "login-prompt-overlay";
    popup.innerHTML = `
            <div class="login-prompt-modal">
                <div class="login-prompt-icon">🔒</div>
                <h2>Login Required</h2>
                <p class="login-prompt-subtitle">You've used your ${GUEST_SEARCH_LIMIT} free searches for today!</p>
                <div class="login-prompt-benefits">
                    <div class="benefit-item">✅ Unlimited searches</div>
                    <div class="benefit-item">❤️ Save to wishlist</div>
                    <div class="benefit-item">🕐 Search history</div>
                    <div class="benefit-item">🔥 Exclusive deals</div>
                </div>
                <a href="login.html" class="login-prompt-btn primary">
                    <span>🚀</span> Login / Sign Up Free
                </a>
                <button class="login-prompt-btn secondary" id="closeLoginPrompt">
                    Maybe Later
                </button>
                <p class="login-prompt-note">Free searches reset daily at midnight</p>
            </div>
        `;

    document.body.appendChild(popup);

    // Close handlers
    document.getElementById("closeLoginPrompt").onclick = () => popup.remove();
    popup.onclick = (e) => {
      if (e.target === popup) popup.remove();
    };

    // Add styles
    addLoginPromptStyles();
  },
};

// Add login prompt styles
function addLoginPromptStyles() {
  if (document.getElementById("login-prompt-styles")) return;

  const style = document.createElement("style");
  style.id = "login-prompt-styles";
  style.textContent = `
        .login-prompt-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: blur(8px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
            animation: fadeIn 0.3s ease;
        }
        .login-prompt-modal {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border: 1px solid rgba(99, 102, 241, 0.3);
            border-radius: 24px;
            padding: 40px;
            max-width: 420px;
            width: 90%;
            text-align: center;
            box-shadow: 0 25px 80px rgba(99, 102, 241, 0.3);
            animation: slideUp 0.4s ease;
        }
        @keyframes slideUp {
            from { opacity: 0; transform: translateY(30px) scale(0.95); }
            to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .login-prompt-icon {
            font-size: 60px;
            margin-bottom: 16px;
            animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
        }
        .login-prompt-modal h2 {
            color: #fff;
            font-size: 28px;
            margin-bottom: 8px;
            font-weight: 700;
        }
        .login-prompt-subtitle {
            color: #ff6b6b;
            font-size: 16px;
            margin-bottom: 24px;
            font-weight: 500;
        }
        .login-prompt-benefits {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 28px;
        }
        .benefit-item {
            background: rgba(99, 102, 241, 0.15);
            padding: 12px 16px;
            border-radius: 12px;
            color: #a5b4fc;
            font-size: 14px;
            font-weight: 500;
            text-align: left;
        }
        .login-prompt-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            width: 100%;
            padding: 16px 24px;
            border-radius: 14px;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s ease;
            text-decoration: none;
            margin-bottom: 12px;
            border: none;
        }
        .login-prompt-btn.primary {
            background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
            color: white;
            box-shadow: 0 10px 40px rgba(99, 102, 241, 0.4);
        }
        .login-prompt-btn.primary:hover {
            transform: translateY(-3px);
            box-shadow: 0 15px 50px rgba(99, 102, 241, 0.5);
        }
        .login-prompt-btn.secondary {
            background: transparent;
            color: #94a3b8;
            border: 1px solid rgba(148, 163, 184, 0.3);
        }
        .login-prompt-btn.secondary:hover {
            background: rgba(148, 163, 184, 0.1);
            color: #fff;
        }
        .login-prompt-note {
            color: #64748b;
            font-size: 12px;
            margin-top: 16px;
        }
        @media (max-width: 480px) {
            .login-prompt-modal { padding: 28px 20px; }
            .login-prompt-modal h2 { font-size: 22px; }
            .login-prompt-benefits { grid-template-columns: 1fr; }
        }
    `;
  document.head.appendChild(style);
}

// Get or create a guest UID for anonymous users
try {
  if (!localStorage.getItem("guest_uid")) {
    localStorage.setItem(
      "guest_uid",
      "guest_" +
        Math.random().toString(36).substring(2, 15) +
        Date.now().toString(36),
    );
  }
} catch (e) {}

function getGuestUid() {
  try {
    return localStorage.getItem("guest_uid");
  } catch (e) {
    return null;
  }
}

function getEffectiveUid() {
  return currentUser ? currentUser.uid : getGuestUid();
}

// ===== Security Utilities =====
const Security = {
  // Sanitize user input to prevent XSS
  sanitizeInput(input) {
    if (!input || typeof input !== "string") return "";
    return input
      .replace(/[<>"'&]/g, "")
      .replace(/javascript:/gi, "")
      .replace(/on\w+=/gi, "")
      .trim()
      .slice(0, 500); // Max length limit
  },

  // Escape HTML entities for display
  escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  },

  // Validate URL - allow any valid HTTPS URL (backend already filters stores)
  isValidUrl(url) {
    if (!url || typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && parsed.hostname.includes(".");
    } catch {
      return false;
    }
  },

  // Validate category ID against known categories
  isValidCategory(catId) {
    // Check if CATEGORIES exists and catId is valid
    return (
      catId &&
      typeof catId === "string" &&
      typeof CATEGORIES !== "undefined" &&
      Object.prototype.hasOwnProperty.call(CATEGORIES, catId)
    );
  },

  // Validate numeric input
  isValidNumber(val, min = 0, max = 999999) {
    const num = parseInt(val);
    return !isNaN(num) && num >= min && num <= max;
  },

  // Rate limiting for client-side actions
  rateLimiter: {
    actions: {},
    check(action, maxPerMinute = 30) {
      const now = Date.now();
      if (!this.actions[action]) this.actions[action] = [];
      // Clean old entries
      this.actions[action] = this.actions[action].filter(
        (t) => now - t < 60000,
      );
      if (this.actions[action].length >= maxPerMinute) return false;
      this.actions[action].push(now);
      return true;
    },
  },
};

// ===== CATEGORIES DATA (Same as Telegram Bot) =====
const CATEGORIES = {
  smartphones: {
    name: "📱 Smartphones",
    store: "flipkart",
    search: "smartphones",
    brands: {
      samsung: "Samsung",
      apple: "Apple",
      oneplus: "OnePlus",
      redmi: "Redmi",
      realme: "Realme",
      vivo: "Vivo",
      oppo: "OPPO",
      poco: "POCO",
      iqoo: "iQOO",
      motorola: "Motorola",
      nothing: "Nothing",
      google: "Google Pixel",
      all: "All Brands",
    },
    prices: [
      ["Under ₹7K", 0, 7000],
      ["₹7K-10K", 7000, 10000],
      ["₹10K-15K", 10000, 15000],
      ["₹15K-20K", 15000, 20000],
      ["₹20K-30K", 20000, 30000],
      ["₹30K-50K", 30000, 50000],
      ["₹50K-80K", 50000, 80000],
      ["Above ₹80K", 80000, 200000],
    ],
    discounts: [
      ["10%+", 10],
      ["20%+", 20],
      ["30%+", 30],
      ["40%+", 40],
    ],
  },
  laptops: {
    name: "💻 Laptops",
    store: "flipkart",
    search: "laptops",
    brands: {
      hp: "HP",
      dell: "Dell",
      lenovo: "Lenovo",
      asus: "ASUS",
      acer: "Acer",
      msi: "MSI",
      apple: "Apple MacBook",
      avita: "Avita",
      infinix: "Infinix",
      all: "All Brands",
    },
    prices: [
      ["Under ₹25K", 0, 25000],
      ["₹25K-35K", 25000, 35000],
      ["₹35K-50K", 35000, 50000],
      ["₹50K-70K", 50000, 70000],
      ["₹70K-1L", 70000, 100000],
      ["Above ₹1L", 100000, 300000],
    ],
    discounts: [
      ["10%+", 10],
      ["20%+", 20],
      ["30%+", 30],
    ],
  },
  audio: {
    name: "🎧 Audio",
    store: "flipkart",
    search: "headphones earphones",
    brands: {
      boat: "boAt",
      noise: "Noise",
      jbl: "JBL",
      sony: "Sony",
      oneplus: "OnePlus",
      realme: "Realme",
      samsung: "Samsung",
      apple: "Apple AirPods",
      zebronics: "Zebronics",
      all: "All Brands",
    },
    prices: [
      ["Under ₹500", 0, 500],
      ["₹500-1K", 500, 1000],
      ["₹1K-2K", 1000, 2000],
      ["₹2K-5K", 2000, 5000],
      ["₹5K-10K", 5000, 10000],
      ["Above ₹10K", 10000, 50000],
    ],
    discounts: [
      ["20%+", 20],
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
    ],
  },
  smartwatches: {
    name: "⌚ Smartwatches",
    store: "flipkart",
    search: "smartwatches",
    brands: {
      noise: "Noise",
      "fire-boltt": "Fire-Boltt",
      boat: "boAt",
      samsung: "Samsung",
      apple: "Apple Watch",
      amazfit: "Amazfit",
      realme: "Realme",
      oneplus: "OnePlus",
      titan: "Titan",
      all: "All Brands",
    },
    prices: [
      ["Under ₹1K", 0, 1000],
      ["₹1K-2K", 1000, 2000],
      ["₹2K-5K", 2000, 5000],
      ["₹5K-10K", 5000, 10000],
      ["₹10K-20K", 10000, 20000],
      ["Above ₹20K", 20000, 100000],
    ],
    discounts: [
      ["20%+", 20],
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
    ],
  },
  "mens-tshirts": {
    name: "👔 Men's T-Shirts",
    store: "myntra",
    search: "men-tshirts",
    brands: {
      puma: "Puma",
      nike: "Nike",
      adidas: "Adidas",
      levis: "Levis",
      hrx: "HRX",
      "us-polo": "US Polo",
      roadster: "Roadster",
      "here-now": "HERE&NOW",
      all: "All Brands",
    },
    prices: [
      ["Under ₹300", 0, 300],
      ["₹300-500", 300, 500],
      ["₹500-800", 500, 800],
      ["₹800-1.2K", 800, 1200],
      ["₹1.2K-2K", 1200, 2000],
      ["Above ₹2K", 2000, 10000],
    ],
    discounts: [
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
      ["60%+", 60],
    ],
  },
  "mens-shirts": {
    name: "👕 Men's Shirts",
    store: "myntra",
    search: "men-shirts",
    brands: {
      levis: "Levis",
      "louis-philippe": "Louis Philippe",
      "peter-england": "Peter England",
      "van-heusen": "Van Heusen",
      "allen-solly": "Allen Solly",
      "us-polo": "US Polo",
      roadster: "Roadster",
      all: "All Brands",
    },
    prices: [
      ["Under ₹500", 0, 500],
      ["₹500-800", 500, 800],
      ["₹800-1.2K", 800, 1200],
      ["₹1.2K-2K", 1200, 2000],
      ["₹2K-3K", 2000, 3000],
      ["Above ₹3K", 3000, 15000],
    ],
    discounts: [
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
      ["60%+", 60],
    ],
  },
  "womens-dresses": {
    name: "👗 Women's Dresses",
    store: "myntra",
    search: "women-dresses",
    brands: {
      only: "ONLY",
      zara: "Zara",
      hm: "H&M",
      mango: "Mango",
      "forever-21": "Forever 21",
      "vero-moda": "Vero Moda",
      sassafras: "SASSAFRAS",
      athena: "Athena",
      all: "All Brands",
    },
    prices: [
      ["Under ₹500", 0, 500],
      ["₹500-1K", 500, 1000],
      ["₹1K-1.5K", 1000, 1500],
      ["₹1.5K-2K", 1500, 2000],
      ["₹2K-3K", 2000, 3000],
      ["Above ₹3K", 3000, 20000],
    ],
    discounts: [
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
      ["60%+", 60],
      ["70%+", 70],
    ],
  },
  "womens-kurtis": {
    name: "🥻 Kurtis & Suits",
    store: "myntra",
    search: "kurtas-kurtis-suits",
    brands: {
      biba: "BIBA",
      w: "W",
      libas: "Libas",
      aurelia: "Aurelia",
      anouk: "Anouk",
      rangmanch: "Rangmanch",
      sangria: "Sangria",
      all: "All Brands",
    },
    prices: [
      ["Under ₹400", 0, 400],
      ["₹400-700", 400, 700],
      ["₹700-1K", 700, 1000],
      ["₹1K-1.5K", 1000, 1500],
      ["₹1.5K-2.5K", 1500, 2500],
      ["Above ₹2.5K", 2500, 15000],
    ],
    discounts: [
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
      ["60%+", 60],
      ["70%+", 70],
    ],
  },
  "womens-sarees": {
    name: "🪭 Sarees",
    store: "myntra",
    search: "sarees",
    brands: {
      "saree-mall": "Saree Mall",
      mimosa: "Mimosa",
      satrani: "Satrani",
      kalini: "Kalini",
      ishin: "Ishin",
      inddus: "Inddus",
      suta: "Suta",
      all: "All Brands",
    },
    prices: [
      ["Under ₹500", 0, 500],
      ["₹500-1K", 500, 1000],
      ["₹1K-2K", 1000, 2000],
      ["₹2K-3K", 2000, 3000],
      ["₹3K-5K", 3000, 5000],
      ["Above ₹5K", 5000, 50000],
    ],
    discounts: [
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
      ["60%+", 60],
      ["70%+", 70],
    ],
  },
  "shoes-men": {
    name: "👟 Men's Shoes",
    store: "myntra",
    search: "men-sports-shoes",
    brands: {
      nike: "Nike",
      adidas: "Adidas",
      puma: "Puma",
      reebok: "Reebok",
      skechers: "Skechers",
      campus: "Campus",
      hrx: "HRX",
      all: "All Brands",
    },
    prices: [
      ["Under ₹1K", 0, 1000],
      ["₹1K-2K", 1000, 2000],
      ["₹2K-3K", 2000, 3000],
      ["₹3K-5K", 3000, 5000],
      ["₹5K-8K", 5000, 8000],
      ["Above ₹8K", 8000, 30000],
    ],
    discounts: [
      ["20%+", 20],
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
    ],
  },
  "shoes-women": {
    name: "👠 Women's Shoes",
    store: "myntra",
    search: "women-heels",
    brands: {
      metro: "Metro",
      "inc-5": "Inc.5",
      mochi: "Mochi",
      catwalk: "Catwalk",
      aldo: "Aldo",
      "steve-madden": "Steve Madden",
      all: "All Brands",
    },
    prices: [
      ["Under ₹800", 0, 800],
      ["₹800-1.5K", 800, 1500],
      ["₹1.5K-2.5K", 1500, 2500],
      ["₹2.5K-4K", 2500, 4000],
      ["₹4K-6K", 4000, 6000],
      ["Above ₹6K", 6000, 25000],
    ],
    discounts: [
      ["20%+", 20],
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
    ],
  },
  beauty: {
    name: "💄 Beauty",
    store: "myntra",
    search: "beauty-and-personal-care",
    brands: {
      maybelline: "Maybelline",
      lakme: "Lakme",
      loreal: "L'Oreal",
      mac: "MAC",
      nykaa: "Nykaa",
      sugar: "Sugar",
      mamaearth: "Mamaearth",
      all: "All Brands",
    },
    prices: [
      ["Under ₹200", 0, 200],
      ["₹200-400", 200, 400],
      ["₹400-700", 400, 700],
      ["₹700-1.2K", 700, 1200],
      ["₹1.2K-2K", 1200, 2000],
      ["Above ₹2K", 2000, 10000],
    ],
    discounts: [
      ["20%+", 20],
      ["30%+", 30],
      ["40%+", 40],
      ["50%+", 50],
    ],
  },
};

// Store icons
const STORE_ICONS = {
  flipkart: "🛒",
  myntra: "👗",
  ajio: "🎯",
};

// Electronics categories - ONLY Flipkart (not on Myntra)
const ELECTRONICS_ONLY = ["smartphones", "laptops", "audio", "smartwatches"];

// Fashion categories - Available on BOTH Flipkart & Myntra
const FASHION_DUAL_STORE = [
  "mens-tshirts",
  "mens-shirts",
  "womens-dresses",
  "womens-kurtis",
  "womens-sarees",
  "shoes-men",
  "shoes-women",
  "beauty",
];

// Wizard state
let wizardState = {
  category: null,
  brand: null,
  brandName: "",
  priceMin: 0,
  priceMax: 999999,
  discount: 0,
  generatedUrl: "",
};

// ===== Category Wizard Functions =====
function initCategoryWizard() {
  // Tab switching
  document.querySelectorAll(".cat-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".cat-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const section = tab.dataset.tab;
      document
        .querySelectorAll(".cat-section")
        .forEach((s) => s.classList.remove("active"));
      document
        .querySelector(`.cat-section[data-section="${section}"]`)
        .classList.add("active");
    });
  });

  // Category selection
  document.querySelectorAll(".cat-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectCategory(btn.dataset.cat));
  });

  // Back buttons
  document
    .getElementById("backToStep1")
    ?.addEventListener("click", () => goToStep(1));
  document
    .getElementById("backToStep2")
    ?.addEventListener("click", () => goToStep(2));
  document
    .getElementById("backToStep3")
    ?.addEventListener("click", () => goToStep(3));

  // Skip discount
  document.getElementById("skipDiscount")?.addEventListener("click", () => {
    wizardState.discount = 0;
    showResult();
  });

  // New search
  document
    .getElementById("newSearchBtn")
    ?.addEventListener("click", resetWizard);

  // Copy link
  document.getElementById("resultCopyBtn")?.addEventListener("click", () => {
    if (wizardState.generatedUrl) {
      navigator.clipboard.writeText(wizardState.generatedUrl).then(() => {
        const btn = document.getElementById("resultCopyBtn");
        btn.textContent = "✅ Copied!";
        setTimeout(() => (btn.textContent = "📋 Copy Link"), 2000);
      });
    }
  });
}

function selectCategory(catId) {
  // Security: Validate category ID
  if (!Security.isValidCategory(catId)) {
    console.warn("Invalid category attempted:", catId);
    return;
  }

  const cat = CATEGORIES[catId];
  wizardState.category = catId;

  // Update progress
  updateProgress(2);

  // Populate brands
  const brandGrid = document.getElementById("brandGrid");
  brandGrid.innerHTML = "";

  for (const [brandId, brandName] of Object.entries(cat.brands)) {
    const btn = document.createElement("button");
    btn.className = "brand-btn" + (brandId === "all" ? " all" : "");
    btn.textContent = brandName;
    btn.onclick = () => selectBrand(brandId, brandName);
    brandGrid.appendChild(btn);
  }

  document.getElementById("brandTitle").textContent =
    `🏷️ Select Brand for ${cat.name}`;
  goToStep(2);
}

function selectBrand(brandId, brandName) {
  // Security: Validate brand exists in current category
  const cat = CATEGORIES[wizardState.category];
  if (!cat || !cat.brands || !cat.brands.hasOwnProperty(brandId)) {
    console.warn("Invalid brand attempted:", brandId);
    return;
  }

  wizardState.brand = brandId;
  wizardState.brandName =
    brandId === "all" ? "" : Security.sanitizeInput(brandName);

  updateProgress(3);

  const priceGrid = document.getElementById("priceGrid");
  priceGrid.innerHTML = "";

  for (const [label, min, max] of cat.prices) {
    const btn = document.createElement("button");
    btn.className = "price-btn";
    btn.textContent = label;
    btn.onclick = () => selectPrice(min, max);
    priceGrid.appendChild(btn);
  }

  goToStep(3);
}

function selectPrice(min, max) {
  // Security: Validate price values
  if (
    !Security.isValidNumber(min, 0, 9999999) ||
    !Security.isValidNumber(max, 0, 9999999)
  ) {
    console.warn("Invalid price range attempted:", min, max);
    return;
  }

  wizardState.priceMin = parseInt(min);
  wizardState.priceMax = parseInt(max);

  updateProgress(4);

  const cat = CATEGORIES[wizardState.category];
  const discountGrid = document.getElementById("discountGrid");
  discountGrid.innerHTML = "";

  for (const [label, discount] of cat.discounts) {
    const btn = document.createElement("button");
    btn.className = "discount-btn";
    btn.textContent = `🏷️ ${label} Off`;
    btn.onclick = () => {
      wizardState.discount = discount;
      showResult();
    };
    discountGrid.appendChild(btn);
  }

  goToStep(4);
}

async function showResult() {
  // Check guest search limit
  if (!GuestLimit.canSearch()) {
    GuestLimit.showLoginPrompt();
    return;
  }

  // Increment search count for guests
  if (!currentUser) {
    const count = GuestLimit.incrementCount();
    const remaining = GuestLimit.getRemainingSearches();
    if (remaining > 0 && remaining <= 2) {
      showSearchLimitWarning(remaining);
    }
  }

  const cat = CATEGORIES[wizardState.category];
  if (!cat) {
    showError("Invalid category selected");
    return;
  }

  const isFashion = FASHION_DUAL_STORE.includes(wizardState.category);

  // Show loading state
  document
    .querySelectorAll(".wizard-step")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById("wizardResult").classList.add("active");

  const summary = document.getElementById("resultSummary");
  summary.innerHTML =
    '<p style="text-align:center;">⏳ Generating your personalized link...</p>';

  // Generate links for the relevant stores
  let flipkartLink = null;
  let myntraLink = null;

  if (isFashion) {
    // Generate both Flipkart and Myntra links for fashion
    const [flipkartResult, myntraResult] = await Promise.all([
      generateDirectLink("flipkart", cat.search, {
        brand: wizardState.brandName,
        price_min: wizardState.priceMin,
        price_max: wizardState.priceMax,
        discount: wizardState.discount,
      }),
      generateDirectLink("myntra", cat.search, {
        brand: wizardState.brandName,
        price_min: wizardState.priceMin,
        price_max: wizardState.priceMax,
        discount: wizardState.discount,
      }),
    ]);

    flipkartLink =
      flipkartResult ||
      generateFallbackUrl("flipkart", cat.search, {
        brand: wizardState.brandName,
        price_min: wizardState.priceMin,
        price_max: wizardState.priceMax,
        discount: wizardState.discount,
      });

    myntraLink =
      myntraResult ||
      generateFallbackUrl("myntra", cat.search, {
        brand: wizardState.brandName,
        price_min: wizardState.priceMin,
        price_max: wizardState.priceMax,
        discount: wizardState.discount,
      });
  } else {
    // Electronics - Flipkart only
    flipkartLink = await generateDirectLink("flipkart", cat.search, {
      brand: wizardState.brandName,
      price_min: wizardState.priceMin,
      price_max: wizardState.priceMax,
      discount: wizardState.discount,
    });

    flipkartLink =
      flipkartLink ||
      generateFallbackUrl("flipkart", cat.search, {
        brand: wizardState.brandName,
        price_min: wizardState.priceMin,
        price_max: wizardState.priceMax,
        discount: wizardState.discount,
      });
  }

  wizardState.generatedUrl = flipkartLink;
  wizardState.myntraUrl = myntraLink;

  // Build summary
  let html = `<p><span>📦 Category:</span> ${cat.name}</p>`;
  if (wizardState.brandName) {
    html += `<p><span>🏷️ Brand:</span> ${wizardState.brandName}</p>`;
  }
  if (wizardState.priceMax < 999999) {
    html += `<p><span>💰 Price:</span> ₹${wizardState.priceMin.toLocaleString()} - ₹${wizardState.priceMax.toLocaleString()}</p>`;
  }
  if (wizardState.discount > 0) {
    html += `<p><span>🏷️ Discount:</span> ${wizardState.discount}%+ off</p>`;
  }

  if (isFashion) {
    html += `<p><span>🏪 Available on:</span> <span class="store-name">Flipkart</span> & <span class="store-name">Myntra</span></p>`;
  } else {
    html += `<p><span>🏪 Store:</span> <span class="store-name">Flipkart</span></p>`;
  }
  summary.innerHTML = html;

  // Update buttons based on category type
  const actionsDiv = document.querySelector("#wizardResult .result-actions");

  if (isFashion) {
    // Show BOTH Flipkart and Myntra buttons
    actionsDiv.innerHTML = `
            <div class="dual-store-buttons">
                <a href="${flipkartLink}" id="shopFlipkartBtn" class="shop-now-btn flipkart-btn" target="_blank">
                    <span>🛒</span>
                    <span>Shop on Flipkart</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </a>
                <a href="${myntraLink}" id="shopMyntraBtn" class="shop-now-btn myntra-btn" target="_blank">
                    <span>👗</span>
                    <span>Shop on Myntra</span>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </a>
            </div>
            <div class="result-subactions">
                <button class="copy-link-btn" id="resultCopyBtn">📋 Copy Flipkart</button>
                <button class="copy-link-btn" id="copyMyntraBtn">📋 Copy Myntra</button>
                <button class="new-search-btn" id="newSearchBtn">🔄 New Search</button>
            </div>
        `;

    // Attach copy handlers for dual buttons
    document.getElementById("resultCopyBtn").onclick = () => {
      navigator.clipboard.writeText(flipkartLink);
      document.getElementById("resultCopyBtn").textContent = "✅ Copied!";
      setTimeout(
        () =>
          (document.getElementById("resultCopyBtn").textContent =
            "📋 Copy Flipkart"),
        2000,
      );
    };
    document.getElementById("copyMyntraBtn").onclick = () => {
      navigator.clipboard.writeText(myntraLink);
      document.getElementById("copyMyntraBtn").textContent = "✅ Copied!";
      setTimeout(
        () =>
          (document.getElementById("copyMyntraBtn").textContent =
            "📋 Copy Myntra"),
        2000,
      );
    };
  } else {
    // Single Flipkart button for electronics
    actionsDiv.innerHTML = `
            <a href="${flipkartLink}" id="shopNowBtn" class="shop-now-btn" target="_blank">
                <span id="shopNowIcon">🛒</span>
                <span>Shop Now on <span id="shopNowStore">Flipkart</span></span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </a>
            <div class="result-subactions">
                <button class="copy-link-btn" id="resultCopyBtn">📋 Copy Link</button>
                <button class="new-search-btn" id="newSearchBtn">🔄 New Search</button>
            </div>
        `;

    // Attach copy handler
    document.getElementById("resultCopyBtn").onclick = () => {
      navigator.clipboard.writeText(flipkartLink);
      document.getElementById("resultCopyBtn").textContent = "✅ Copied!";
      setTimeout(
        () =>
          (document.getElementById("resultCopyBtn").textContent =
            "📋 Copy Link"),
        2000,
      );
    };
  }

  // Attach new search handler
  document.getElementById("newSearchBtn").onclick = () => {
    resetWizard();
  };

  // Save search history for category wizard too
  saveSearchHistory(cat.name, {
    platform: isFashion ? "flipkart,myntra" : "flipkart",
    category: wizardState.category,
    brand: wizardState.brandName,
    minDiscount: wizardState.discount,
  });

  // Update progress to completed
  document
    .querySelectorAll(".progress-step")
    .forEach((s) => s.classList.add("completed"));
}

function goToStep(step) {
  document
    .querySelectorAll(".wizard-step")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById(`wizardStep${step}`).classList.add("active");
}

function updateProgress(activeStep) {
  document.querySelectorAll(".progress-step").forEach((step) => {
    const stepNum = parseInt(step.dataset.step);
    step.classList.remove("active", "completed");
    if (stepNum < activeStep) step.classList.add("completed");
    if (stepNum === activeStep) step.classList.add("active");
  });
}

function resetWizard() {
  wizardState = {
    category: null,
    brand: null,
    brandName: "",
    priceMin: 0,
    priceMax: 999999,
    discount: 0,
    generatedUrl: "",
  };

  document.querySelectorAll(".progress-step").forEach((s, i) => {
    s.classList.remove("active", "completed");
    if (i === 0) s.classList.add("active");
  });

  document
    .querySelectorAll(".wizard-step")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById("wizardStep1").classList.add("active");
}

// Generate direct store link with filters (same as bot)
async function generateDirectLink(store, query, filters = {}) {
  // Security: Rate limit link generation
  if (!Security.rateLimiter.check("generateLink", 15)) {
    showError("Too many requests. Please wait.");
    return null;
  }

  // Security: Validate store
  const validStores = ["flipkart", "myntra", "ajio"];
  if (!validStores.includes(store?.toLowerCase())) {
    console.warn("Invalid store:", store);
    store = "flipkart";
  }

  try {
    const params = new URLSearchParams({
      store: store.toLowerCase(),
      query: Security.sanitizeInput(query) || "deals",
      brand: Security.sanitizeInput(filters.brand || ""),
      price_min: Security.isValidNumber(filters.price_min)
        ? filters.price_min
        : 0,
      price_max: Security.isValidNumber(filters.price_max)
        ? filters.price_max
        : 999999,
      discount: Security.isValidNumber(filters.discount, 0, 100)
        ? filters.discount
        : 0,
      color: Security.sanitizeInput(filters.color || ""),
    });

    // Use cached API manager
    const data = await APIManager.fetch(
      `${API_BASE}/generate-link?${params.toString()}`,
    );

    if (data.success && data.affiliate_url) {
      // Accept any valid HTTPS URL — backend already validates stores
      try {
        const parsed = new URL(data.affiliate_url);
        if (parsed.protocol === "https:" && parsed.hostname.includes(".")) {
          return data.affiliate_url;
        }
      } catch {}
      console.warn("API returned invalid affiliate URL:", data.affiliate_url);
    }
    // If API returns success but no valid affiliate URL, use original
    if (data.original_url) {
      return data.original_url;
    }
    // Generate fallback
    return generateFallbackUrl(store, query, filters);
  } catch (error) {
    console.error("Link generation error:", error);
    // Fallback: Generate URL locally
    return generateFallbackUrl(store, query, filters);
  }
}

// Fallback URL generation when API fails
function generateFallbackUrl(store, query, filters = {}) {
  const { brand, price_min, price_max, discount } = filters;

  if (store === "myntra") {
    let url = `https://www.myntra.com/${query.replace(/ /g, "-")}`;
    const params = [];
    if (brand) params.push(`f=Brand%3A${encodeURIComponent(brand)}`);
    if (price_max < 999999)
      params.push(`price=${price_min || 0}%2C${price_max}`);
    if (discount) params.push(`discount=${discount}%3A100`);
    params.push("sort=popularity");
    if (params.length) url += "?" + params.join("&");
    return url;
  } else {
    // Flipkart
    let searchTerms = brand ? `${brand} ${query}` : query;
    let url = `https://www.flipkart.com/search?q=${encodeURIComponent(searchTerms)}`;
    if (price_max < 999999) {
      url += `&p%5B%5D=facets.price_range.from%3D${price_min || 0}`;
      url += `&p%5B%5D=facets.price_range.to%3D${price_max}`;
    }
    if (discount) {
      url += `&p%5B%5D=facets.discount_range%5B%5D%3D${discount}%25+or+more`;
    }
    url += "&sort=popularity";
    return url;
  }
}

// Direct product links - use affiliate URL from product data
function getProductUrl(originalUrl) {
  return originalUrl;
}

// ===== Prevent duplicate API calls =====
let isLoadingDeals = false;
let isLoadingDealOfDay = false;
let dealsLoaded = false;
let dealOfDayLoaded = false;
let topDealsCache = null;
let searchAbortController = null;

// ===== Deal of the Day Functions =====
let dealOfDayTimer = null;

async function loadDealOfDay() {
  const dealSection = document.getElementById("dealOfDay");
  if (!dealSection) return;

  // Prevent duplicate calls
  if (isLoadingDealOfDay || dealOfDayLoaded) return;

  // Show only for logged-in users
  if (!currentUser) {
    dealSection.style.display = "none";
    return;
  }

  isLoadingDealOfDay = true;
  dealSection.style.display = "block";

  try {
    // Use cached deals API (same endpoint as loadTopDeals for efficiency)
    const data = await APIManager.fetch(`${API_BASE}/deals?limit=8`);
    if (data.deals && data.deals.length > 0) {
      // Filter high discount deals and pick random
      const hotDeals = data.deals.filter((d) => d.discount >= 50);
      if (hotDeals.length > 0) {
        const randomDeal =
          hotDeals[Math.floor(Math.random() * hotDeals.length)];
        displayDealOfDay(randomDeal);
        dealOfDayLoaded = true;
      } else {
        dealSection.style.display = "none";
      }
    } else {
      dealSection.style.display = "none";
    }
  } catch (error) {
    console.log("Could not load deal of day:", error);
    dealSection.style.display = "none";
  } finally {
    isLoadingDealOfDay = false;
  }
}

function displayDealOfDay(deal) {
  const dealContent = document.getElementById("dealContent");
  if (!dealContent) return;

  // Security: Validate deal object
  if (!deal || !deal.id || !deal.title) {
    console.warn("Invalid deal object");
    return;
  }

  // Cache product for wishlist
  productsCache[deal.id] = deal;
  const isInWishlist = userWishlist.some((p) => p.id === deal.id);

  // Security: Validate and sanitize deal data
  const safeImage =
    deal.image && /^https:\/\//.test(deal.image)
      ? deal.image
      : "data:image/svg+xml,%3Csvg width=300 height=200%3E%3Crect fill=%23e5e7eb width=300 height=200/%3E%3Ctext fill=%239ca3af font-family=sans-serif font-size=16 dy=.35em text-anchor=middle x=150 y=100%3ENo Image%3C/text%3E%3C/svg%3E";
  const safeDiscount = Security.isValidNumber(deal.discount, 0, 100)
    ? deal.discount
    : 0;
  const safePrice = Security.isValidNumber(deal.price) ? deal.price : 0;
  const safeOriginalPrice = Security.isValidNumber(deal.original_price)
    ? deal.original_price
    : safePrice;
  const safePlatform = Security.sanitizeInput(deal.platform) || "Store";
  const safeUrl = Security.isValidUrl(deal.affiliate_url)
    ? deal.affiliate_url
    : "#";
  const safeId = Security.sanitizeInput(String(deal.id));

  dealContent.innerHTML = `
        <div class="deal-card">
            <div class="deal-image">
                <img src="${safeImage}" alt="${escapeHtml(deal.title)}" onerror="this.src='data:image/svg+xml,%3Csvg width=300 height=200%3E%3Crect fill=%23e5e7eb width=300 height=200/%3E%3Ctext fill=%239ca3af font-family=sans-serif font-size=16 dy=.35em text-anchor=middle x=150 y=100%3ENo Image%3C/text%3E%3C/svg%3E'">
                <span class="deal-badge">🔥 ${safeDiscount}% OFF</span>
            </div>
            <div class="deal-info">
                <span class="deal-platform platform-${safePlatform.toLowerCase()}">${escapeHtml(safePlatform)}</span>
                <h3 class="deal-title">${escapeHtml(deal.title)}</h3>
                <p class="deal-brand">${escapeHtml(deal.brand)}</p>
                <div class="deal-price">
                    <span class="current-price">₹${formatPrice(safePrice)}</span>
                    <span class="original-price">₹${formatPrice(safeOriginalPrice)}</span>
                    <span class="savings">You save ₹${formatPrice(safeOriginalPrice - safePrice)}</span>
                </div>
                <div class="deal-timer">
                    <span>⏰ Ends in: </span>
                    <span id="dealTimer">23:59:59</span>
                </div>
                <div class="deal-actions">
                    <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="deal-buy-btn" ${safeUrl === "#" ? 'onclick="return false;"' : ""}>
                        Grab Deal 🛒
                    </a>
                    <button class="deal-wishlist-btn ${isInWishlist ? "active" : ""}" onclick="handleWishlistClick('${safeId}')">
                        ${isInWishlist ? "❤️" : "🤍"}
                    </button>
                </div>
            </div>
        </div>
    `;

  // Start countdown timer
  startDealTimer();
}

function startDealTimer() {
  if (dealOfDayTimer) clearInterval(dealOfDayTimer);

  // Set end time to midnight
  const now = new Date();
  const endTime = new Date(now);
  endTime.setHours(23, 59, 59, 999);

  function updateTimer() {
    const now = new Date();
    const diff = endTime - now;

    if (diff <= 0) {
      const timerEl = document.getElementById("dealTimer");
      if (timerEl) timerEl.textContent = "Deal Ended!";
      clearInterval(dealOfDayTimer); // Stop timer, don't reload
      return;
    }

    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    const secs = Math.floor((diff % 60000) / 1000);

    const timerEl = document.getElementById("dealTimer");
    if (timerEl) {
      timerEl.textContent = `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
  }

  updateTimer();
  dealOfDayTimer = setInterval(updateTimer, 1000);
}

// ===== Mobile Menu Toggle =====
function toggleMobileMenu() {
  const navLinks = document.querySelector(".nav-links");
  const mobileMenuBtn = document.querySelector(".mobile-menu-btn");

  if (navLinks && mobileMenuBtn) {
    navLinks.classList.toggle("active");
    mobileMenuBtn.classList.toggle("active");
  }
}

// ===== DOM Elements =====
const searchBtn = document.getElementById("searchBtn");
const clearBtn = document.getElementById("clearBtn");
const loadingContainer = document.getElementById("loadingContainer");
const productsGrid = document.getElementById("productsGrid");
const resultsHeader = document.getElementById("resultsHeader");
const resultsCount = document.getElementById("resultsCount");
const noResults = document.getElementById("noResults");
const shimmerGrid = document.getElementById("shimmerGrid");
const quickBtns = document.querySelectorAll(".quick-btn");

// Filter inputs
const platformInput = document.getElementById("platform");
const categoryInput = document.getElementById("category");
const brandInput = document.getElementById("brand");
const minPriceInput = document.getElementById("minPrice");
const maxPriceInput = document.getElementById("maxPrice");
const minDiscountInput = document.getElementById("minDiscount");
const sortByInput = document.getElementById("sortBy");

// ===== State =====
let userWishlist = [];
let currentUser = null;
let productsCache = {}; // Store products by ID for wishlist

// ===== Firestore Functions =====

// Wishlist cache (in-memory + sessionStorage)
let _wishlistPromise = null;

// Load wishlist from backend API (cached via sessionStorage + promise deduping)
function loadWishlist() {
  if (!currentUser) return Promise.resolve();
  if (_wishlistPromise) return _wishlistPromise;

  // Check sessionStorage first
  const cached = sessionStorage.getItem("wishlist_cache");
  if (cached) {
    try {
      userWishlist = JSON.parse(cached);
      updateWishlistCount();
      return Promise.resolve();
    } catch (e) {
      sessionStorage.removeItem("wishlist_cache");
    }
  }

  _wishlistPromise = APIManager.fetch(`${API_BASE}/wishlist/${currentUser.uid}`)
    .then((data) => {
      if (data.success && data.items) {
        userWishlist = data.items.map((item) => ({
          id: item.product_id,
          title: item.title,
          brand: item.brand,
          price: item.price,
          original_price: item.original_price,
          discount: item.discount,
          image: item.image,
          platform: item.platform,
          affiliate_url: item.affiliate_url,
          rating: item.rating,
          reviews: item.reviews,
          addedAt: item.added_at,
        }));
        sessionStorage.setItem("wishlist_cache", JSON.stringify(userWishlist));
        updateWishlistCount();
      }
    })
    .catch((error) => {
      console.log("Could not load wishlist:", error);
    })
    .finally(() => {
      _wishlistPromise = null;
    });

  return _wishlistPromise;
}

// Force refresh wishlist (after add/remove)
function invalidateWishlistCache() {
  _wishlistPromise = null;
  sessionStorage.removeItem("wishlist_cache");
}

// Add to wishlist
async function addToWishlist(product) {
  if (!currentUser) {
    showError("Please login to add to wishlist");
    return;
  }

  // Security: Rate limit wishlist actions
  if (!Security.rateLimiter.check("wishlist", 30)) {
    showError("Too many actions. Please wait.");
    return;
  }

  // Security: Validate product object
  if (!product || !product.id || !product.title) {
    showError("Invalid product");
    return;
  }

  if (userWishlist.some((p) => p.id === product.id)) {
    showError("Already in wishlist!");
    return;
  }

  try {
    userWishlist.push({
      id: product.id,
      title: product.title,
      brand: product.brand,
      price: product.price,
      original_price: product.original_price,
      discount: product.discount,
      image: product.image,
      platform: product.platform,
      affiliate_url: product.affiliate_url,
      rating: product.rating,
      reviews: product.reviews,
      addedAt: new Date().toISOString(),
    });

    await APIManager.fetch(`${API_BASE}/wishlist/${currentUser.uid}`, {
      method: "POST",
      body: JSON.stringify({ product }),
    });

    updateWishlistCount();
    updateHeartIcon(product.id, true);
    showSuccess("Added to wishlist! ❤️");
    sessionStorage.setItem("wishlist_cache", JSON.stringify(userWishlist));
  } catch (error) {
    console.error("Wishlist error:", error);
    showError("Failed to add to wishlist");
    invalidateWishlistCache();
  }
}

// Remove from wishlist
async function removeFromWishlist(productId) {
  if (!currentUser) return;

  try {
    userWishlist = userWishlist.filter((p) => p.id !== productId);

    await APIManager.fetch(
      `${API_BASE}/wishlist/${currentUser.uid}/${productId}`,
      {
        method: "DELETE",
      },
    );

    updateWishlistCount();
    updateHeartIcon(productId, false);
    showSuccess("Removed from wishlist");

    // Refresh if viewing wishlist
    if (document.getElementById("wishlistNav")?.classList.contains("active")) {
      displayWishlist();
    }
    // Update cache with new list
    sessionStorage.setItem("wishlist_cache", JSON.stringify(userWishlist));
  } catch (error) {
    console.error("Remove wishlist error:", error);
    invalidateWishlistCache();
  }
}

// Toggle wishlist
function toggleWishlist(product) {
  const isInWishlist = userWishlist.some((p) => p.id === product.id);
  if (isInWishlist) {
    removeFromWishlist(product.id);
  } else {
    addToWishlist(product);
  }
}

// Update heart icon on product card
function updateHeartIcon(productId, isActive) {
  const card = document.querySelector(`[data-product-id="${productId}"]`);
  if (card) {
    const btn = card.querySelector(".wishlist-btn");
    if (btn) {
      if (isActive) {
        btn.classList.add("active");
        btn.innerHTML = "❤️";
      } else {
        btn.classList.remove("active");
        btn.innerHTML = "🤍";
      }
    }
  }
}

// Update wishlist count
function updateWishlistCount() {
  const countEl = document.getElementById("wishlistCount");
  if (countEl) {
    countEl.textContent =
      userWishlist.length > 0 ? `(${userWishlist.length})` : "";
  }
}

// Display wishlist
function displayWishlist() {
  if (shimmerGrid) shimmerGrid.style.display = "none";
  if (noResults) noResults.style.display = "none";
  hideLoading();

  if (!currentUser) {
    showError("Please login to view wishlist");
    return;
  }

  // Re-cache wishlist products for heart icon toggle
  userWishlist.forEach((p) => {
    productsCache[p.id] = p;
  });

  if (userWishlist.length === 0) {
    productsGrid.innerHTML = "";
    resultsHeader.style.display = "none";
    noResults.style.display = "block";
    noResults.innerHTML = `
            <div class="no-results-icon">❤️</div>
            <h3>Wishlist is empty</h3>
            <p>Click the heart icon on products to save them here</p>
        `;
    return;
  }

  resultsHeader.style.display = "none";
  productsGrid.innerHTML = userWishlist
    .map((product) => createProductCard(product))
    .join("");
}

// Save search history (works for both logged-in and guest users)
async function saveSearchHistory(query, filters) {
  const uid = getEffectiveUid();
  if (!uid) return;

  try {
    await APIManager.fetch(`${API_BASE}/history/${uid}`, {
      method: "POST",
      body: JSON.stringify({
        query: query || "",
        platform: filters.platform || null,
        category: filters.category || null,
        brand: filters.brand || null,
        minDiscount: filters.minDiscount ? parseInt(filters.minDiscount) : null,
      }),
    });
    // Invalidate cache so next history view gets fresh data
    sessionStorage.removeItem("search_history_cache");
  } catch (error) {
    console.log("Could not save search history:", error);
  }
}

// Display search history (cached via sessionStorage)
async function displaySearchHistory(preloadedHistory = null) {
  const uid = getEffectiveUid();
  if (!uid) {
    showError("Please login to view history");
    return;
  }

  if (shimmerGrid) shimmerGrid.style.display = "none";
  if (noResults) noResults.style.display = "none";
  if (productsGrid) productsGrid.innerHTML = "";
  hideLoading();

  try {
    let history = preloadedHistory;
    if (!history) {
      const cached = sessionStorage.getItem("search_history_cache");
      if (cached) {
        try {
          history = JSON.parse(cached);
        } catch (e) {
          sessionStorage.removeItem("search_history_cache");
        }
      }
    }

    if (!history) {
      const data = await APIManager.fetch(`${API_BASE}/history/${uid}`);
      if (data.success && data.history) {
        history = data.history.map((item) => ({
          query: item.query,
          filters: {
            platform: item.platform || "",
            category: item.category || "",
            brand: item.brand || "",
            minDiscount: item.min_discount || "",
          },
          timestamp: item.created_at,
        }));
      } else {
        history = [];
      }
      sessionStorage.setItem("search_history_cache", JSON.stringify(history));
    }

    resultsHeader.style.display = "none";

    if (history.length === 0) {
      noResults.style.display = "block";
      noResults.innerHTML = `
                <div class="no-results-icon">🕐</div>
                <h3>No search history</h3>
                <p>Your recent searches will appear here</p>
            `;
      return;
    }

    productsGrid.innerHTML = `
            <div class="history-list">
                ${history
                  .map(
                    (item, index) => `
                    <div class="history-item" onclick="replaySearch(${parseInt(index)})">
                        <span class="history-icon">🔍</span>
                        <div class="history-details">
                            <span class="history-query">${Security.escapeHtml(item.query) || "All Products"}</span>
                            <span class="history-filters">
                                ${item.filters.platform ? `Platform: ${Security.escapeHtml(item.filters.platform)}` : ""}
                                ${item.filters.category ? `Category: ${Security.escapeHtml(item.filters.category)}` : ""}
                                ${item.filters.minDiscount ? `${parseInt(item.filters.minDiscount) || 0}%+ Off` : ""}
                            </span>
                            <span class="history-time">${Security.escapeHtml(formatTimeAgo(item.timestamp))}</span>
                        </div>
                    </div>
                `,
                  )
                  .join("")}
            </div>
        `;
  } catch (error) {
    console.error("History error:", error);
    showError("Failed to load history");
  }
}

// Replay search
async function replaySearch(index) {
  try {
    let history = [];
    const cached = sessionStorage.getItem("search_history_cache");
    if (cached) {
      try {
        history = JSON.parse(cached);
      } catch (e) {
        sessionStorage.removeItem("search_history_cache");
      }
    }
    if (!history.length) {
      const data = await APIManager.fetch(
        `${API_BASE}/history/${currentUser.uid}`,
      );
      if (data.success && data.history) {
        history = data.history.map((item) => ({
          query: item.query,
          filters: {
            platform: item.platform || "",
            category: item.category || "",
            brand: item.brand || "",
            minDiscount: item.min_discount || "",
          },
          timestamp: item.created_at,
        }));
      }
    }
    const search = history[index];
    if (!search) return;

    if (search.filters.platform) platformInput.value = search.filters.platform;
    if (search.filters.category) categoryInput.value = search.filters.category;
    if (search.filters.minDiscount)
      minDiscountInput.value = search.filters.minDiscount;

    const searchQuery = document.getElementById("searchQuery");
    if (searchQuery && search.query) searchQuery.value = search.query;

    setActiveNav("deals");
    window.location.href = `search.html?q=${encodeURIComponent(search.query)}`;
  } catch (error) {
    console.error("Replay search error:", error);
  }
}

// ===== Event Listeners =====
if (searchBtn) searchBtn.addEventListener("click", searchProducts);
if (clearBtn) clearBtn.addEventListener("click", clearFilters);

quickBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const filterType = btn.dataset.filter;
    const filterValue = btn.dataset.value;

    btn.classList.toggle("active");

    if (filterType === "platform" && platformInput) {
      platformInput.value = btn.classList.contains("active") ? filterValue : "";
    } else if (filterType === "category" && categoryInput) {
      categoryInput.value = btn.classList.contains("active") ? filterValue : "";
    } else if (filterType === "discount" && minDiscountInput) {
      minDiscountInput.value = btn.classList.contains("active")
        ? filterValue
        : "";
    }

    setActiveNav("deals");

    // For quick buttons with specific filters, offer direct link
    if (
      btn.classList.contains("active") &&
      filterType === "discount" &&
      filterValue >= 50
    ) {
      // Show direct link for hot deals
      const store = platformInput?.value || "Flipkart";
      const query = categoryInput?.value || "all";

      showSuccess(`🔥 Generating ${filterValue}%+ off deals...`);

      const link = await generateDirectLink(store.toLowerCase(), query, {
        discount: parseInt(filterValue),
      });

      if (link) {
        // Ask user if they want direct link or search results
        const useDirectLink = confirm(
          `Found ${filterValue}%+ off deals!\n\nClick OK to browse directly on ${store}, or Cancel to see results here.`,
        );
        if (useDirectLink) {
          window.open(link, "_blank");
          btn.classList.remove("active");
          return;
        }
      }
    }

    searchProducts();
  });
});

document.querySelectorAll(".filter-group input").forEach((input) => {
  input.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      const pagePath = window.location.pathname.split("/").pop();
      if (
        _pagePath === "index.html" ||
        _pagePath === "" ||
        _pagePath === "index"
      ) {
        window.location.href = `search.html?q=${encodeURIComponent(input.value)}`;
      } else {
        searchProducts();
      }
    }
  });
});

// ===== Intelligent Brand Filtering =====
// Brand options based on category
const brandsByCategory = {
  Smartphones: [
    "All Brands",
    "Samsung",
    "Realme",
    "Xiaomi",
    "OnePlus",
    "Vivo",
    "Apple",
    "Oppo",
    "Motorola",
    "iQOO",
    "Poco",
  ],
  Laptops: [
    "All Brands",
    "HP",
    "Lenovo",
    "Dell",
    "Asus",
    "Acer",
    "Apple",
    "MSI",
  ],
  Earphones: [
    "All Brands",
    "boAt",
    "JBL",
    "Noise",
    "Sony",
    "Realme",
    "OnePlus",
    "Samsung",
  ],
  Shoes: [
    "All Brands",
    "Puma",
    "Nike",
    "Adidas",
    "Reebok",
    "Campus",
    "Sparx",
    "Bata",
  ],
  Watches: [
    "All Brands",
    "Noise",
    "boAt",
    "Fire-Boltt",
    "Fastrack",
    "Titan",
    "Fossil",
  ],
  Clothing: [
    "All Brands",
    "Roadster",
    "H&M",
    "Allen Solly",
    "Van Heusen",
    "Peter England",
    "Wrogn",
    "Mast & Harbour",
  ],
};

// Update brand dropdown when category changes
function updateBrandDropdown(category) {
  const brandSelect = document.getElementById("brand");
  if (!brandSelect) return;

  // Clear existing options
  brandSelect.innerHTML = '<option value="">All Brands</option>';

  if (category && brandsByCategory[category]) {
    brandsByCategory[category].forEach((brand) => {
      if (brand !== "All Brands") {
        const option = document.createElement("option");
        option.value = brand;
        option.textContent = brand;
        brandSelect.appendChild(option);
      }
    });
  } else {
    // If no category selected, show all brands
    const allBrands = new Set();
    Object.values(brandsByCategory).forEach((brands) => {
      brands.forEach((brand) => {
        if (brand !== "All Brands") allBrands.add(brand);
      });
    });
    Array.from(allBrands)
      .sort()
      .forEach((brand) => {
        const option = document.createElement("option");
        option.value = brand;
        option.textContent = brand;
        brandSelect.appendChild(option);
      });
  }
}

// Listen to category changes
if (categoryInput) {
  categoryInput.addEventListener("change", () => {
    updateBrandDropdown(categoryInput.value);
  });
}

// ===== Main Search Function =====
async function searchProducts() {
  const heroSearchBtn = document.getElementById("heroSearchBtn");
  if (heroSearchBtn) {
    heroSearchBtn.disabled = true;
    heroSearchBtn.style.opacity = "0.6";
    heroSearchBtn.style.cursor = "not-allowed";
  }

  // Check guest search limit FIRST
  if (!GuestLimit.canSearch()) {
    GuestLimit.showLoginPrompt();
    hideLoading();
    if (heroSearchBtn) {
      heroSearchBtn.disabled = false;
      heroSearchBtn.style.opacity = "";
      heroSearchBtn.style.cursor = "";
    }
    return;
  }

  // Security: Rate limit searches
  if (!Security.rateLimiter.check("search", 20)) {
    showError("Too many searches. Please wait a moment.");
    if (heroSearchBtn) {
      heroSearchBtn.disabled = false;
      heroSearchBtn.style.opacity = "";
      heroSearchBtn.style.cursor = "";
    }
    return;
  }

  // Increment search count for guests
  if (!currentUser) {
    const count = GuestLimit.incrementCount();
    const remaining = GuestLimit.getRemainingSearches();
    if (remaining > 0 && remaining <= 2) {
      showSearchLimitWarning(remaining);
    }
  }

  showLoading();
  setActiveNav("deals");

  const params = new URLSearchParams();

  // Security: Sanitize all inputs
  const searchQuery = Security.sanitizeInput(
    document.getElementById("searchQuery")?.value ||
      document.getElementById("heroSearch")?.value ||
      "",
  );
  const platform = Security.sanitizeInput(platformInput?.value || "");
  const category = Security.sanitizeInput(categoryInput?.value || "");
  const brand = Security.sanitizeInput(brandInput?.value || "");
  const minPrice = Security.isValidNumber(minPriceInput?.value)
    ? minPriceInput.value.trim()
    : "";
  const maxPrice = Security.isValidNumber(maxPriceInput?.value)
    ? maxPriceInput.value.trim()
    : "";
  const minDiscount = Security.isValidNumber(minDiscountInput?.value, 0, 100)
    ? minDiscountInput.value.trim()
    : "";
  const sortBy = ["price_asc", "price_desc", "discount", "rating", ""].includes(
    sortByInput?.value,
  )
    ? sortByInput.value
    : "";

  if (searchQuery) params.append("q", searchQuery);
  if (platform) params.append("platform", platform);
  if (category) params.append("category", category);
  if (brand) params.append("brand", brand);
  if (minPrice) params.append("min_price", minPrice);
  if (maxPrice) params.append("max_price", maxPrice);
  if (minDiscount) params.append("min_discount", minDiscount);
  if (sortBy) params.append("sort_by", sortBy);

  // Save to history
  saveSearchHistory(searchQuery, { platform, category, minDiscount });

  // Create abort controller for this search
  searchAbortController = new AbortController();

  try {
    const data = await APIManager.fetch(
      `${API_BASE}/search?${params.toString()}`,
      { signal: searchAbortController.signal },
    );

    // Sort results by price low to high by default
    if (data.products && Array.isArray(data.products)) {
      data.products.sort((a, b) => {
        const priceA =
          typeof a.price === "number"
            ? a.price
            : parseFloat(String(a.price).replace(/[^0-9.]/g, "")) || 0;
        const priceB =
          typeof b.price === "number"
            ? b.price
            : parseFloat(String(b.price).replace(/[^0-9.]/g, "")) || 0;
        return priceA - priceB;
      });
    }

    // Always show direct link option when platform is selected
    const filters = {
      platform: platform || "Flipkart",
      query: searchQuery || category || "deals",
      category: category,
      brand: brand,
      price_min: parseInt(minPrice) || 0,
      price_max: parseInt(maxPrice) || 999999,
      discount: parseInt(minDiscount) || 0,
    };

    // Always use displayProductsWithDirectLink when platform or search is specified
    if (platform || searchQuery || category) {
      displayProductsWithDirectLink(data, filters);
    } else {
      displayProducts(data);
    }
  } catch (error) {
    if (
      error.name === "AbortError" ||
      (error.message && error.message.includes("aborted"))
    ) {
      console.log("Search cancelled by user");
      hideLoading();
    } else {
      console.error("Search error:", error);
      showError("Failed to fetch products. Please try again.");
      hideLoading();
    }
  } finally {
    searchAbortController = null;
    const heroSearchBtnFinally = document.getElementById("heroSearchBtn");
    if (heroSearchBtnFinally) {
      heroSearchBtnFinally.disabled = false;
      heroSearchBtnFinally.style.opacity = "";
      heroSearchBtnFinally.style.cursor = "";
    }
  }
}

// Helper: show styled no-results card
function showNoResultsCard(title, message, showReset = true) {
  if (productsGrid) productsGrid.innerHTML = "";
  if (resultsHeader) resultsHeader.style.display = "none";
  if (noResults) {
    noResults.style.display = "block";
    const titleEl = document.getElementById("noResultsTitle");
    const textEl = document.getElementById("noResultsText");
    const btnEl = document.getElementById("noResultsBtn");
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = message;
    if (btnEl) btnEl.style.display = showReset ? "inline-flex" : "none";
  }
}

// ===== Display Products with Direct Link Option =====
function displayProductsWithDirectLink(data, filters) {
  hideLoading();
  if (shimmerGrid) shimmerGrid.style.display = "none";

  // Always show direct link banner - even with no results
  const storeName = filters.platform || "Store";
  const directLinkHtml = `
        <div class="direct-store-link-card" id="directStoreLinkCard">
            <div class="store-link-glow"></div>
            <div class="store-link-content">
                <div class="store-link-icon">${getStoreEmoji(storeName)}</div>
                <div class="store-link-info">
                    <h4>🔗 Browse on ${storeName}</h4>
                    <p>Click to open ${storeName} with your filters applied</p>
                    <div class="store-link-filters">
                        ${filters.query ? `<span class="filter-tag">🔍 ${filters.query}</span>` : ""}
                        ${filters.brand ? `<span class="filter-tag">🏷️ ${filters.brand}</span>` : ""}
                        ${filters.price_max < 999999 ? `<span class="filter-tag">💰 Under ₹${filters.price_max}</span>` : ""}
                        ${filters.discount > 0 ? `<span class="filter-tag">🔥 ${filters.discount}%+ off</span>` : ""}
                    </div>
                </div>
                <button class="store-link-btn" id="directLinkBtn">
                    <span class="btn-text">Open ${storeName}</span>
                    <span class="btn-arrow">→</span>
                </button>
            </div>
        </div>
    `;

  const hasProducts =
    data.products && Array.isArray(data.products) && data.products.length > 0;
  const count = data.count || 0;

  if (!hasProducts || count === 0) {
    showNoResultsCard(
      "No search product found",
      "We couldn't find any products matching your search. Try different keywords or browse the store directly.",
    );
    return;
  }

  noResults.style.display = "none";
  resultsHeader.style.display = "block";
  resultsCount.innerHTML = `Found ${data.count} products`;

  // Add direct link card before products
  productsGrid.innerHTML =
    directLinkHtml +
    data.products.map((product) => createProductCard(product)).join("");
  attachDirectLinkHandler(filters);
}

// Get store emoji
function getStoreEmoji(store) {
  const emojis = {
    Flipkart: "🛒",
    flipkart: "🛒",
    Myntra: "👗",
    myntra: "👗",
    Ajio: "🎯",
    ajio: "🎯",
  };
  return emojis[store] || "🛍️";
}

// Attach click handler for direct link button
function attachDirectLinkHandler(filters) {
  const directLinkBtn = document.getElementById("directLinkBtn");
  if (directLinkBtn) {
    directLinkBtn.addEventListener("click", async () => {
      directLinkBtn.disabled = true;
      directLinkBtn.querySelector(".btn-text").textContent = "⏳ Generating...";

      const store = (filters.platform || "flipkart").toLowerCase();
      const query = filters.query || filters.category || "deals";

      const link = await generateDirectLink(store, query, {
        brand: filters.brand,
        price_min: filters.price_min,
        price_max: filters.price_max,
        discount: filters.discount,
      });

      if (link && Security.isValidUrl(link)) {
        // Show the link before opening
        showGeneratedLinkPopup(link, filters.platform || "Store", query);
        window.open(link, "_blank", "noopener,noreferrer");
        directLinkBtn.querySelector(".btn-text").textContent = "✅ Opened!";
        setTimeout(() => {
          directLinkBtn.disabled = false;
          directLinkBtn.querySelector(".btn-text").textContent =
            `Open ${filters.platform || "Store"}`;
        }, 2000);
      } else {
        directLinkBtn.disabled = false;
        directLinkBtn.querySelector(".btn-text").textContent = "❌ Failed";
        setTimeout(() => {
          directLinkBtn.querySelector(".btn-text").textContent =
            `Open ${filters.platform || "Store"}`;
        }, 2000);
      }
    });
  }
}

// Show popup with generated link for sharing
function showGeneratedLinkPopup(link, store, query) {
  // Remove existing popup if any
  const existingPopup = document.querySelector(".link-popup-overlay");
  if (existingPopup) existingPopup.remove();

  const popup = document.createElement("div");
  popup.className = "link-popup-overlay";
  popup.innerHTML = `
        <div class="link-popup glass">
            <button class="link-popup-close">&times;</button>
            <div class="link-popup-header">
                <span class="link-popup-icon">${getStoreEmoji(store)}</span>
                <h3>Your Link is Ready!</h3>
            </div>
            <div class="link-popup-preview">
                <strong>${query} on ${store}</strong>
                <p class="link-url">${link.substring(0, 50)}...</p>
            </div>
            <div class="link-popup-actions">
                <button class="link-popup-btn copy" id="popupCopyBtn">
                    📋 Copy Link
                </button>
                <button class="link-popup-btn share" id="popupShareBtn">
                    📤 Share
                </button>
            </div>
        </div>
    `;

  document.body.appendChild(popup);

  // Close handlers
  popup.querySelector(".link-popup-close").onclick = () => popup.remove();
  popup.onclick = (e) => {
    if (e.target === popup) popup.remove();
  };

  // Copy button
  popup.querySelector("#popupCopyBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      popup.querySelector("#popupCopyBtn").textContent = "✅ Copied!";
      showSuccess("Link copied to clipboard!");
    } catch (e) {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = link;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      popup.querySelector("#popupCopyBtn").textContent = "✅ Copied!";
    }
  };

  // Share button
  popup.querySelector("#popupShareBtn").onclick = async () => {
    const shareText = `🛍️ Check out ${query} on ${store}!\n\n🔗 ${link}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `${query} on ${store}`, url: link });
      } catch (e) {}
    } else {
      // Copy for sharing
      await navigator.clipboard.writeText(shareText);
      popup.querySelector("#popupShareBtn").textContent = "✅ Copied!";
      showSuccess("Share text copied!");
    }
  };

  // Auto close after 10 seconds
  setTimeout(() => popup.remove(), 10000);
}

// ===== Display Products =====
function displayProducts(data) {
  hideLoading();
  if (shimmerGrid) shimmerGrid.style.display = "none";

  const hasProducts =
    data.products && Array.isArray(data.products) && data.products.length > 0;
  if (!hasProducts || data.count === 0) {
    showNoResultsCard(
      "No search product found",
      "We couldn't find any products matching your search. Try different keywords or adjust your filters.",
    );
    return;
  }

  noResults.style.display = "none";
  resultsHeader.style.display = "block";
  resultsCount.textContent = `Found ${data.count} products`;
  productsGrid.innerHTML = data.products
    .map((product) => createProductCard(product))
    .join("");
}

// ===== Create Product Card =====
function createProductCard(product) {
  const platformClass = `platform-${product.platform.toLowerCase()}`;
  const formattedPrice = formatPrice(product.price);
  const formattedOriginalPrice = formatPrice(product.original_price);
  const fallbackImage =
    "data:image/svg+xml,%3Csvg width=250 height=200%3E%3Crect fill=%23e5e7eb width=250 height=200/%3E%3Ctext fill=%239ca3af font-family=sans-serif font-size=14 dy=.35em text-anchor=middle x=125 y=100%3ENo Image%3C/text%3E%3C/svg%3E";

  // Cache product for wishlist
  productsCache[product.id] = product;

  const isInWishlist = userWishlist.some((p) => p.id === product.id);
  const wishlistBtnClass = isInWishlist
    ? "wishlist-btn active"
    : "wishlist-btn";
  const wishlistIcon = isInWishlist ? "❤️" : "🤍";

  return `
        <div class="product-card" data-product-id="${product.id}">
            <div class="product-image-container">
                <img src="${product.image}" alt="${escapeHtml(product.title)}" class="product-image"
                    onerror="this.src='${fallbackImage}'" loading="lazy">
                <button class="${wishlistBtnClass}"
                    onclick="handleWishlistClick('${product.id}')"
                    title="${isInWishlist ? "Remove from wishlist" : "Add to wishlist"}">
                    ${wishlistIcon}
                </button>
                ${product.discount >= 50 ? '<span class="product-badge">🔥 Hot Deal</span>' : ""}
            </div>
            <div class="product-info">
                <span class="product-platform ${platformClass}">${product.platform}</span>
                <div class="product-brand">${escapeHtml(product.brand)}</div>
                <h3 class="product-title">${escapeHtml(product.title)}</h3>
                <div class="product-price-section">
                    <span class="product-price">₹${formattedPrice}</span>
                    <span class="product-original-price">₹${formattedOriginalPrice}</span>
                    <span class="product-discount">(${product.discount}% OFF)</span>
                </div>
                <div class="product-rating">
                    <span class="rating-badge">${product.rating || 4.0} ★</span>
                    <span class="rating-count">(${formatCount(product.reviews || 100)} reviews)</span>
                </div>
                <a href="${Security.isValidUrl(product.affiliate_url) ? product.affiliate_url : "#"}" target="_blank" rel="noopener noreferrer" class="buy-btn" onclick="return Security.isValidUrl('${product.affiliate_url?.replace(/'/g, "\\'") || ""}')">
                    Buy Now 🛒
                </a>
            </div>
        </div>
    `;
}

// Escape HTML to prevent XSS (wrapper for Security.escapeHtml)
function escapeHtml(text) {
  return Security.escapeHtml(text);
}

// Handle wishlist click
function handleWishlistClick(productId) {
  const product = productsCache[productId];
  if (product) {
    toggleWishlist(product);
  } else {
    showError("Product not found");
  }
}

// ===== Helper Functions =====
function formatPrice(price) {
  return price.toLocaleString("en-IN");
}

function formatCount(count) {
  if (count >= 1000) return (count / 1000).toFixed(1) + "K";
  return count;
}

function formatTimeAgo(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function showLoading() {
  if (loadingContainer) loadingContainer.style.display = "block";
  if (productsGrid) productsGrid.innerHTML = "";
  if (resultsHeader) resultsHeader.style.display = "none";
  if (noResults) noResults.style.display = "none";
  if (shimmerGrid) shimmerGrid.style.display = "none";
  const pagination = document.getElementById("topDealsPagination");
  if (pagination) pagination.style.display = "none";
}

function hideLoading() {
  if (loadingContainer) loadingContainer.style.display = "none";
}

function showError(message) {
  const toast = document.createElement("div");
  toast.className = "error-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showSuccess(message) {
  const toast = document.createElement("div");
  toast.className = "success-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// Show warning when running low on free searches
function showSearchLimitWarning(remaining) {
  const toast = document.createElement("div");
  toast.className = "warning-toast";
  toast.innerHTML = `⚠️ Only <strong>${remaining}</strong> free search${remaining > 1 ? "es" : ""} left today! <a href="login.html" style="color:#fff;text-decoration:underline;">Login for unlimited</a>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);

  // Add warning toast style if not exists
  if (!document.getElementById("warning-toast-style")) {
    const style = document.createElement("style");
    style.id = "warning-toast-style";
    style.textContent = `
            .warning-toast {
                position: fixed;
                bottom: 100px;
                left: 50%;
                transform: translateX(-50%);
                background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
                color: white;
                padding: 14px 24px;
                border-radius: 12px;
                font-size: 14px;
                font-weight: 600;
                z-index: 9999;
                box-shadow: 0 10px 40px rgba(245, 158, 11, 0.4);
                animation: slideUp 0.3s ease;
            }
        `;
    document.head.appendChild(style);
  }
}

function setActiveNav(page) {
  document
    .querySelectorAll(".nav-link")
    .forEach((link) => link.classList.remove("active"));
  if (page === "wishlist") {
    document.getElementById("wishlistNav")?.classList.add("active");
  } else if (page === "history") {
    document.getElementById("historyNav")?.classList.add("active");
  } else {
    document.querySelector(".nav-link")?.classList.add("active");
  }
}

function clearFilters() {
  if (platformInput) platformInput.value = "";
  if (categoryInput) categoryInput.value = "";
  if (brandInput) brandInput.value = "";
  if (minPriceInput) minPriceInput.value = "";
  if (maxPriceInput) maxPriceInput.value = "";
  if (minDiscountInput) minDiscountInput.value = "";
  if (sortByInput) sortByInput.value = "";

  const searchQuery = document.getElementById("searchQuery");
  if (searchQuery) searchQuery.value = "";

  quickBtns.forEach((btn) => btn.classList.remove("active"));

  if (productsGrid) productsGrid.innerHTML = "";
  if (resultsHeader) resultsHeader.style.display = "none";
  if (noResults) noResults.style.display = "none";
  if (shimmerGrid) shimmerGrid.style.display = "none";
}

// ===== Load Top Deals =====
const DEALS_CACHE_VERSION = "3"; // bump when backend data format changes

const TOP_DEALS_SESSION_TTL = 5 * 60 * 1000; // 5 minutes (same as backend Redis)

let currentTopDealsPage = 1;
let topDealsTotal = 0;

function loadTopDealsPage(delta) {
  const newPage = currentTopDealsPage + delta;
  if (newPage < 1) return;
  const maxPage = Math.ceil(topDealsTotal / 30) || 1;
  if (newPage > maxPage) return;
  currentTopDealsPage = newPage;
  loadTopDeals(true, currentTopDealsPage);
}

async function loadTopDeals(forceRefresh = false, page = 1) {
  // Prevent duplicate calls
  if (isLoadingDeals) return;

  const cacheKey = `topDealsCache_page${page}`;

  // Try to restore from sessionStorage first
  if (!forceRefresh) {
    try {
      const cachedVersion = sessionStorage.getItem("topDealsCacheVersion");
      const cached = sessionStorage.getItem(cacheKey);
      const cachedTimestamp = sessionStorage.getItem("topDealsCacheTimestamp");
      const now = Date.now();
      if (
        cached &&
        cachedVersion === DEALS_CACHE_VERSION &&
        cachedTimestamp &&
        now - parseInt(cachedTimestamp, 10) < TOP_DEALS_SESSION_TTL
      ) {
        const data = JSON.parse(cached);
        renderTopDeals(data);
        return;
      } else {
        sessionStorage.removeItem(cacheKey);
      }
    } catch (e) {
      sessionStorage.removeItem(cacheKey);
    }
  }

  isLoadingDeals = true;

  try {
    const data = await APIManager.fetch(
      `${API_BASE}/deals?page=${page}&per_page=30`,
    );
    if (data.products && data.products.length > 0) {
      topDealsTotal = data.total || 0;
      currentTopDealsPage = data.page || 1;
      // Persist to sessionStorage
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(data));
        sessionStorage.setItem("topDealsCacheVersion", DEALS_CACHE_VERSION);
        sessionStorage.setItem("topDealsCacheTimestamp", String(Date.now()));
      } catch (e) {
        // sessionStorage might be full — ignore
      }
      renderTopDeals(data);
    } else {
      hideLoading();
      if (shimmerGrid) shimmerGrid.style.display = "grid";
      const pagination = document.getElementById("topDealsPagination");
      if (pagination) pagination.style.display = "none";
    }
  } catch (error) {
    console.error("Could not load top deals:", error);
    hideLoading();
    if (shimmerGrid) shimmerGrid.style.display = "grid";
    const pagination = document.getElementById("topDealsPagination");
    if (pagination) pagination.style.display = "none";
  } finally {
    isLoadingDeals = false;
  }
}

function renderTopDeals(data) {
  hideLoading();
  if (shimmerGrid) shimmerGrid.style.display = "none";
  resultsHeader.style.display = "block";
  resultsCount.textContent = "🔥 Top Deals for You";
  productsGrid.innerHTML = data.products
    .map((product) => createProductCard(product))
    .join("");
  dealsLoaded = true;

  // Pagination controls
  const pagination = document.getElementById("topDealsPagination");
  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  const pageInfo = document.getElementById("pageInfo");
  const totalPages = Math.ceil((data.total || 0) / (data.per_page || 30)) || 1;

  if (pagination) pagination.style.display = "flex";
  if (pageInfo)
    pageInfo.textContent = `Page ${data.page || 1} of ${totalPages}`;
  if (prevBtn) prevBtn.disabled = (data.page || 1) <= 1;
  if (nextBtn) nextBtn.disabled = (data.page || 1) >= totalPages;
}

// ===== Initialize =====
document.addEventListener("DOMContentLoaded", () => {
  const _pagePath = window.location.pathname.split("/").pop();

  // Mobile performance optimizations
  if (isMobile || isLowEndDevice) {
    // Use passive listeners for touch events
    document.addEventListener("touchstart", () => {}, { passive: true });
    document.addEventListener("touchmove", () => {}, { passive: true });
    document.addEventListener("scroll", () => {}, { passive: true });

    // Reduce animation duration on low-end devices
    if (isLowEndDevice) {
      document.documentElement.style.setProperty(
        "--transition-normal",
        "0.15s ease",
      );
      document.documentElement.style.setProperty(
        "--transition-slow",
        "0.25s ease",
      );
    }
  }

  // ===== Smart Suggestions for Hero Search =====
  const SUGGESTIONS = {
    smartphones: [
      { name: "Samsung Galaxy S24 Ultra", icon: "📱", tag: "Flagship" },
      { name: "iPhone 15 Pro Max", icon: "🍎", tag: "Premium" },
      { name: "OnePlus 12", icon: "🔴", tag: "Performance" },
      { name: "Realme Narzo 70 Pro", icon: "🟡", tag: "Budget" },
      { name: "Vivo V30 Pro", icon: "🟣", tag: "Camera" },
      { name: "Nothing Phone 2", icon: "⚫", tag: "Unique" },
      { name: "Google Pixel 8 Pro", icon: "🔵", tag: "AI" },
      { name: "Xiaomi 14 Pro", icon: "🟠", tag: "Value" },
    ],
    laptops: [
      { name: "HP Pavilion Gaming", icon: "💻", tag: "Gaming" },
      { name: "Dell XPS 15", icon: "🟦", tag: "Premium" },
      { name: "MacBook Air M3", icon: "🍏", tag: "Lightweight" },
      { name: "Lenovo Legion 5 Pro", icon: "🟩", tag: "Gaming" },
      { name: "ASUS VivoBook S15", icon: "🟧", tag: "Everyday" },
      { name: "Acer Aspire 5", icon: "🟢", tag: "Budget" },
      { name: "MSI Katana 15", icon: "🔴", tag: "Gaming" },
    ],
    shoes: [
      { name: "Nike Air Max 270", icon: "👟", tag: "Sporty" },
      { name: "Adidas Ultraboost 22", icon: "👟", tag: "Running" },
      { name: "Puma RS-X", icon: "👟", tag: "Lifestyle" },
      { name: "Campus Sutra", icon: "👟", tag: "Budget" },
      { name: "New Balance 574", icon: "👟", tag: "Classic" },
      { name: "Reebok Zig Kinetica", icon: "👟", tag: "Trendy" },
    ],
    earphones: [
      { name: "boAt Airdopes 141", icon: "🎧", tag: "Budget" },
      { name: "Sony WF-1000XM5", icon: "🎧", tag: "Premium" },
      { name: "JBL Tune 230NC TWS", icon: "🎧", tag: "ANC" },
      { name: "OnePlus Buds Pro 2", icon: "🎧", tag: "Quality" },
      { name: "Noise Buds VS404", icon: "🎧", tag: "Value" },
      { name: "Apple AirPods Pro", icon: "🎧", tag: "Apple" },
    ],
    watches: [
      { name: "Fire-Boltt Phoenix Ultra", icon: "⌚", tag: "Budget" },
      { name: "Noise ColorFit Pro 4", icon: "⌚", tag: "Features" },
      { name: "boAt Wave Call 2", icon: "⌚", tag: "Budget" },
      { name: "Apple Watch Series 9", icon: "⌚", tag: "Premium" },
      { name: "Samsung Galaxy Watch 6", icon: "⌚", tag: "Android" },
      { name: "Amazfit GTR 4", icon: "⌚", tag: "Fitness" },
    ],
    clothing: [
      { name: "Levis 511 Slim Fit", icon: "👖", tag: "Jeans" },
      { name: "H&M Cotton Shirt", icon: "👕", tag: "Casual" },
      { name: "Zara Summer Dress", icon: "👗", tag: "Women" },
      { name: "Roadster T-Shirt", icon: "👔", tag: "Men" },
      { name: "Allen Solly Formal", icon: "👔", tag: "Office" },
      { name: "Puma Track Pants", icon: "👖", tag: "Sports" },
    ],
  };

  // Create suggestion dropdown (appended to body so it sits above all sections)
  const suggestionBox = document.createElement("div");
  suggestionBox.id = "heroSuggestionBox";
  suggestionBox.style.cssText = `
            position: fixed;
            z-index: 99999;
            background: rgba(30, 30, 40, 0.98);
            border-radius: 16px;
            box-shadow: 0 8px 32px rgba(99,102,241,0.18);
            display: none;
            padding: 12px 0;
            max-height: ${isMobile ? "260px" : "320px"};
            overflow-y: auto;
            font-size: ${isMobile ? "15px" : "16px"};
            color: #fff;
            ${isMobile ? "" : "backdrop-filter: blur(8px);"}
            border: 1px solid rgba(99,102,241,0.18);
            -webkit-overflow-scrolling: touch;
        `;

  document.body.appendChild(suggestionBox);

  function positionSuggestionBox() {
    const wrapper = document.querySelector(".hero-search");
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    suggestionBox.style.top = rect.bottom + 4 + "px";
    suggestionBox.style.left = rect.left + "px";
    suggestionBox.style.width = rect.width + "px";
  }

  function showSuggestions(query) {
    let key = "";
    let categoryName = "";
    query = query.toLowerCase();

    // Enhanced keyword detection
    if (
      query.includes("smartphone") ||
      query.includes("phone") ||
      query.includes("mobile")
    ) {
      key = "smartphones";
      categoryName = "📱 Popular Smartphones";
    } else if (query.includes("laptop") || query.includes("notebook")) {
      key = "laptops";
      categoryName = "💻 Top Laptops";
    } else if (
      query.includes("shoe") ||
      query.includes("sneaker") ||
      query.includes("footwear")
    ) {
      key = "shoes";
      categoryName = "👟 Trending Shoes";
    } else if (
      query.includes("earphone") ||
      query.includes("headphone") ||
      query.includes("earbud") ||
      query.includes("audio")
    ) {
      key = "earphones";
      categoryName = "🎧 Best Audio Gear";
    } else if (query.includes("watch") || query.includes("smartwatch")) {
      key = "watches";
      categoryName = "⌚ Smartwatches";
    } else if (
      query.includes("cloth") ||
      query.includes("shirt") ||
      query.includes("jeans") ||
      query.includes("dress") ||
      query.includes("tshirt") ||
      query.includes("pant")
    ) {
      key = "clothing";
      categoryName = "👕 Fashion Picks";
    }

    if (key && SUGGESTIONS[key]) {
      const header = `<div style="padding:16px 24px 12px;font-size:13px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;">${categoryName}</div>`;
      const items = SUGGESTIONS[key]
        .map(
          (s) =>
            `<div class="suggestion-item" style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 24px;cursor:pointer;transition:all 0.2s;border-bottom:1px solid rgba(99,102,241,0.06);" onmouseover="this.style.background='rgba(99,102,241,0.12)';this.style.transform='translateX(4px)';" onmouseout="this.style.background='none';this.style.transform='translateX(0)';">
                        <div style="display:flex;align-items:center;gap:14px;flex:1;">
                            <span style="font-size:28px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));">${s.icon}</span>
                            <span style="font-weight:600;font-size:15px;color:var(--text-primary);">${s.name}</span>
                        </div>
                        <span style="font-size:11px;padding:4px 10px;background:rgba(99,102,241,0.15);color:var(--accent-light);border-radius:12px;font-weight:600;">${s.tag}</span>
                    </div>`,
        )
        .join("");
      suggestionBox.innerHTML = header + items;
      positionSuggestionBox();
      suggestionBox.style.display = "block";
    } else {
      suggestionBox.style.display = "none";
    }
  }

  // Hero Search functionality (declared early for suggestions)
  const heroSearchBtn = document.getElementById("heroSearchBtn");
  const heroSearch = document.getElementById("heroSearch");
  const heroSearchWrapperRef = document.querySelector(".hero-search");

  if (heroSearch) {
    heroSearch.addEventListener("input", (e) => {
      const val = heroSearch.value.trim();
      if (val.length > 2) {
        showSuggestions(val);
      } else {
        suggestionBox.style.display = "none";
      }
    });

    suggestionBox.addEventListener("mousedown", (e) => {
      if (e.target.closest(".suggestion-item")) {
        const text = e.target.closest(".suggestion-item").innerText;
        heroSearch.value = text;
        suggestionBox.style.display = "none";
      }
    });

    window.addEventListener(
      "scroll",
      () => {
        suggestionBox.style.display = "none";
      },
      { passive: true },
    );

    window.addEventListener("resize", () => {
      if (suggestionBox.style.display === "block") {
        positionSuggestionBox();
      }
    });

    document.addEventListener("click", (e) => {
      if (
        heroSearchWrapperRef &&
        !heroSearchWrapperRef.contains(e.target) &&
        !suggestionBox.contains(e.target)
      ) {
        suggestionBox.style.display = "none";
      }
    });

    // Show/hide clear button based on input
    const clearSearchBtn = document.getElementById("clearSearchBtn");
    if (clearSearchBtn) {
      heroSearch.addEventListener("input", () => {
        clearSearchBtn.style.display =
          heroSearch.value.trim().length > 0 ? "flex" : "none";
      });

      clearSearchBtn.addEventListener("click", () => {
        // Abort any pending search request
        if (searchAbortController) {
          searchAbortController.abort();
          searchAbortController = null;
        }
        heroSearch.value = "";
        clearSearchBtn.style.display = "none";
        suggestionBox.style.display = "none";
        if (noResults) noResults.style.display = "none";
        hideLoading();
        // Re-enable search button if it was disabled
        const heroSearchBtn = document.getElementById("heroSearchBtn");
        if (heroSearchBtn) {
          heroSearchBtn.disabled = false;
          heroSearchBtn.style.opacity = "";
          heroSearchBtn.style.cursor = "";
        }
        // Show cached top deals instead of initial state
        loadTopDeals();
      });
    }
  }
  // Initialize brand dropdown with all brands
  updateBrandDropdown("");

  const pagePathInit = window.location.pathname.split("/").pop();
  if (pagePathInit === "" || pagePathInit === "index.html") {
    // Show loading immediately instead of "Start exploring deals!" placeholder
    if (shimmerGrid) shimmerGrid.style.display = "grid";

    // Clear top deals sessionStorage cache on page load so refresh gets fresh data
    Object.keys(sessionStorage).forEach((key) => {
      if (key.startsWith("topDealsCache_")) sessionStorage.removeItem(key);
    });
    sessionStorage.removeItem("topDealsCacheVersion");
    sessionStorage.removeItem("topDealsCacheTimestamp");

    loadTopDeals();
  }

  if (heroSearchBtn) {
    heroSearchBtn.addEventListener("click", async () => {
      suggestionBox.style.display = "none";

      // Check guest search limit FIRST
      if (!GuestLimit.canSearch()) {
        GuestLimit.showLoginPrompt();
        return;
      }

      // Security: Sanitize and validate hero search input
      const rawQuery = heroSearch?.value || "";
      const query = Security.sanitizeInput(rawQuery);

      if (!query || query.length < 2) {
        showError("Please enter a valid search term (min 2 characters)");
        return;
      }

      if (query.length > 100) {
        showError("Search term too long");
        return;
      }

      // Security: Rate limit hero searches
      if (!Security.rateLimiter.check("heroSearch", 10)) {
        showError("Too many searches. Please wait.");
        return;
      }

      // Increment search count for guests
      if (!currentUser) {
        const count = GuestLimit.incrementCount();
        const remaining = GuestLimit.getRemainingSearches();
        if (remaining > 0 && remaining <= 2) {
          showSearchLimitWarning(remaining);
        }
      }

      // Redirect to dedicated search page
      window.location.href = `search.html?q=${encodeURIComponent(query)}`;
    });
  }

  if (heroSearch) {
    heroSearch.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        suggestionBox.style.display = "none";
        const query = heroSearch.value.trim();
        if (!query || query.length < 2) {
          showError("Please enter a valid search term (min 2 characters)");
          return;
        }
        if (!GuestLimit.canSearch()) {
          GuestLimit.showLoginPrompt();
          return;
        }
        if (!currentUser) {
          GuestLimit.incrementCount();
        }
        window.location.href = `search.html?q=${encodeURIComponent(query)}`;
      }
    });
  }

  // Explore button
  const exploreBtn = document.getElementById("exploreBtn");
  if (exploreBtn) {
    exploreBtn.addEventListener("click", () => {
      window.location.href = "search.html";
    });
  }

  // Filters toggle
  const filtersToggle = document.getElementById("filtersToggle");
  const filtersGrid = document.getElementById("filtersGrid");
  if (filtersToggle && filtersGrid) {
    filtersToggle.addEventListener("click", () => {
      filtersGrid.classList.toggle("active");
      filtersToggle.classList.toggle("active");
      const text = filtersToggle.querySelector("span");
      if (text) {
        text.textContent = filtersGrid.classList.contains("active")
          ? "Hide Filters"
          : "Show Filters";
      }
    });
  }

  // Mobile menu toggle
  const mobileMenuBtn = document.getElementById("mobileMenuBtn");
  const mobileNav = document.getElementById("mobileNav");
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener("click", () => {
      mobileMenuBtn.classList.toggle("active");
      if (mobileNav) mobileNav.classList.toggle("active");
    });
  }

  // Mobile nav links
  document.querySelectorAll(".mobile-nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const nav = link.dataset.nav;
      document
        .querySelectorAll(".mobile-nav-link")
        .forEach((l) => l.classList.remove("active"));
      link.classList.add("active");

      if (nav === "wishlist") {
        setActiveNav("wishlist");
        displayWishlist();
      } else if (nav === "history") {
        setActiveNav("history");
        displaySearchHistory();
      } else {
        setActiveNav("deals");
        loadTopDeals();
      }

      // Close mobile menu
      if (mobileMenuBtn) mobileMenuBtn.classList.remove("active");
      if (mobileNav) mobileNav.classList.remove("active");
    });
  });

  // Single auth state listener for all pages
  let lastAuthState = null;
  if (window.auth) {
    window.auth.onAuthStateChanged((user) => {
      // Prevent duplicate handling
      const currentState = user ? user.uid : null;
      if (currentState === lastAuthState) return;
      lastAuthState = currentState;

      currentUser = user;
      updateAuthUI(user);
      if (user) {
        // Sync Firebase auth user to Supabase PostgreSQL
        APIManager.fetch(`${API_BASE}/auth/sync`, {
          method: "POST",
          body: JSON.stringify({
            uid: user.uid,
            email: user.email,
            display_name: user.displayName,
            photo_url: user.photoURL,
            provider: "firebase",
          }),
        }).catch((err) => console.log("Auth sync error:", err));

        if (_pagePath === "wishlist.html") {
          loadWishlist().then(() => displayWishlist());
        } else if (_pagePath === "history.html") {
          displaySearchHistory();
        } else {
          loadWishlist();
          loadDealOfDay();
        }
      } else {
        userWishlist = [];
        updateWishlistCount();
        hideDealOfDay();
        dealOfDayLoaded = false;
        if (_pagePath === "wishlist.html" || _pagePath === "history.html") {
          showError("Please login to view this page");
        }
      }
    });
  }

  // Auto-search on dedicated search page
  if (_pagePath === "search.html") {
    const urlParams = new URLSearchParams(window.location.search);
    const q = urlParams.get("q") || "";
    const platform = urlParams.get("platform") || "";
    const category = urlParams.get("category") || "";
    const brand = urlParams.get("brand") || "";
    const minPrice = urlParams.get("min_price") || "";
    const maxPrice = urlParams.get("max_price") || "";
    const minDiscount = urlParams.get("min_discount") || "";
    const sortBy = urlParams.get("sort_by") || "";

    if (heroSearch) heroSearch.value = q;
    if (platformInput) platformInput.value = platform;
    if (categoryInput) categoryInput.value = category;
    if (brandInput) brandInput.value = brand;
    if (minPriceInput) minPriceInput.value = minPrice;
    if (maxPriceInput) maxPriceInput.value = maxPrice;
    if (minDiscountInput) minDiscountInput.value = minDiscount;
    if (sortByInput) sortByInput.value = sortBy;

    // Update search title
    const searchTitle = document.getElementById("searchTitle");
    const searchSubtitle = document.getElementById("searchSubtitle");
    if (q) {
      if (searchTitle) searchTitle.textContent = `Results for "${q}"`;
      if (searchSubtitle)
        searchSubtitle.textContent = "Finding the best deals across stores...";
    } else {
      if (searchTitle) searchTitle.textContent = "Search Results";
      if (searchSubtitle)
        searchSubtitle.textContent = "Browse all available deals";
    }

    // Run search after a brief delay to let page settle
    if (q || platform || category || brand) {
      setTimeout(() => {
        searchProducts();
      }, 100);
    }
  }

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", function (e) {
      const href = this.getAttribute("href");
      if (href && href.length > 1) {
        const target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: "smooth" });
        }
      }
    });
  });
});

// Update Auth UI
function updateAuthUI(user) {
  const userSection = document.getElementById("userSection");
  const wishlistNav = document.getElementById("wishlistNav");
  const historyNav = document.getElementById("historyNav");

  if (user) {
    const displayName = user.displayName || user.email?.split("@")[0] || "User";
    if (userSection) {
      userSection.innerHTML = `
        <div class="user-logged-in">
          <div class="user-avatar">${displayName.charAt(0).toUpperCase()}</div>
          <span class="user-name">${displayName}</span>
          <button class="logout-btn glass" onclick="firebase.auth().signOut()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      `;
    }
    if (wishlistNav) wishlistNav.style.display = "flex";
    if (historyNav) historyNav.style.display = "flex";
    // Persist auth info for instant header restore on next page
    sessionStorage.setItem(
      "auth_user",
      JSON.stringify({
        uid: user.uid,
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
      }),
    );
  } else {
    if (userSection) {
      userSection.innerHTML = `
        <button class="login-btn glass" onclick="window.location.href='login.html'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>Login</span>
        </button>
      `;
    }
    if (wishlistNav) wishlistNav.style.display = "none";
    if (historyNav) historyNav.style.display = "none";
    sessionStorage.removeItem("auth_user");
    sessionStorage.removeItem("wishlist_cache");
    sessionStorage.removeItem("search_history_cache");
  }
}

// Apply cached auth state instantly (before Firebase responds)
(function applyInstantAuthState() {
  const cached = sessionStorage.getItem("auth_user");
  if (!cached) return;
  try {
    const user = JSON.parse(cached);
    currentUser = user; // Make auth state available immediately for data loading

    const userSection = document.getElementById("userSection");
    const wishlistNav = document.getElementById("wishlistNav");
    const historyNav = document.getElementById("historyNav");
    const displayName = user.displayName || user.email?.split("@")[0] || "User";
    if (userSection) {
      userSection.innerHTML = `
        <div class="user-logged-in">
          <div class="user-avatar">${displayName.charAt(0).toUpperCase()}</div>
          <span class="user-name">${displayName}</span>
          <button class="logout-btn glass" onclick="firebase.auth().signOut()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      `;
    }
    if (wishlistNav) wishlistNav.style.display = "flex";
    if (historyNav) historyNav.style.display = "flex";

    // Restore wishlist count for ALL pages (nav badge must show instantly)
    const wl = sessionStorage.getItem("wishlist_cache");
    if (wl) {
      try {
        userWishlist = JSON.parse(wl);
        updateWishlistCount();
      } catch (e) {
        sessionStorage.removeItem("wishlist_cache");
      }
    }

    // Instant render from sessionStorage cache before Firebase responds
    const page = window.location.pathname.split("/").pop();
    if (page === "wishlist.html" && wl) {
      displayWishlist();
    } else if (page === "history.html") {
      const hist = sessionStorage.getItem("search_history_cache");
      if (hist) {
        try {
          displaySearchHistory(JSON.parse(hist));
        } catch (e) {
          sessionStorage.removeItem("search_history_cache");
        }
      }
    }
  } catch (e) {
    sessionStorage.removeItem("auth_user");
  }
})();

// Hide deal of day for non-logged users
function hideDealOfDay() {
  const dealSection = document.getElementById("dealOfDay");
  if (dealSection) dealSection.style.display = "none";
}

// Logout function
async function logout() {
  if (window.auth) {
    try {
      await window.auth.signOut();
      showSuccess("Logged out successfully!");
      window.location.reload();
    } catch (error) {
      showError("Logout failed");
    }
  }
}

// ===== Direct Store Link Generator (Like Telegram Bot) =====

// Store icons and display names
const storeConfig = {
  flipkart: {
    icon: "🛒",
    name: "Flipkart",
    domain: "flipkart.com",
    color: "#2874f0",
  },
  myntra: {
    icon: "👗",
    name: "Myntra",
    domain: "myntra.com",
    color: "#ff3f6c",
  },
  ajio: { icon: "🎯", name: "Ajio", domain: "ajio.com", color: "#3d3d3d" },
};

// Initialize link generator
function initLinkGenerator() {
  const generateBtn = document.getElementById("generateLinkBtn");
  const copyBtn = document.getElementById("copyLinkBtn");
  const shareBtn = document.getElementById("shareLinkBtn");
  const linkCard = document.getElementById("generatedLinkCard");
  const linkPreview = document.querySelector(".link-card-preview");

  if (generateBtn) {
    generateBtn.addEventListener("click", handleGenerateLink);
  }

  if (copyBtn) {
    copyBtn.addEventListener("click", handleCopyLink);
  }

  if (shareBtn) {
    shareBtn.addEventListener("click", handleShareLink);
  }

  // Click on preview to open link
  if (linkPreview) {
    linkPreview.addEventListener("click", () => {
      const openBtn = document.getElementById("openLinkBtn");
      if (openBtn) window.open(openBtn.href, "_blank");
    });
  }

  // Enter key on query input
  const queryInput = document.getElementById("linkQuery");
  if (queryInput) {
    queryInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") handleGenerateLink();
    });
  }
}

// Generate link handler
async function handleGenerateLink() {
  const generateBtn = document.getElementById("generateLinkBtn");
  const linkCard = document.getElementById("generatedLinkCard");

  // Get values
  const store = document.getElementById("linkStore")?.value || "flipkart";
  const query = document.getElementById("linkQuery")?.value.trim();
  const brand = document.getElementById("linkBrand")?.value.trim() || "";
  const minPrice =
    parseInt(document.getElementById("linkMinPrice")?.value) || 0;
  const maxPrice =
    parseInt(document.getElementById("linkMaxPrice")?.value) || 999999;
  const discount =
    parseInt(document.getElementById("linkDiscount")?.value) || 0;

  // Validation
  if (!query) {
    showError("Please enter what you're looking for!");
    document.getElementById("linkQuery")?.focus();
    return;
  }

  // Show loading state
  generateBtn.disabled = true;
  generateBtn.innerHTML =
    '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> <span>Generating...</span>';

  try {
    const link = await generateDirectLink(store, query, {
      brand: brand,
      price_min: minPrice,
      price_max: maxPrice,
      discount: discount,
    });

    if (link) {
      // Show the link card
      displayGeneratedLink(
        store,
        query,
        brand,
        minPrice,
        maxPrice,
        discount,
        link,
      );
      showSuccess("🔗 Link generated successfully!");
    } else {
      showError("Failed to generate link. Try again!");
    }
  } catch (error) {
    console.error("Link generation error:", error);
    showError("Something went wrong. Please try again.");
  } finally {
    // Reset button
    generateBtn.disabled = false;
    generateBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> <span>Generate Link</span>';
  }
}

// Display the generated link in attractive card
function displayGeneratedLink(
  store,
  query,
  brand,
  minPrice,
  maxPrice,
  discount,
  link,
) {
  const linkCard = document.getElementById("generatedLinkCard");
  const config = storeConfig[store];

  // Build title
  let title = `${query.charAt(0).toUpperCase() + query.slice(1)}`;
  if (brand) title += ` by ${brand}`;
  title += ` on ${config.name}`;

  // Build description with filters
  let desc = "🛍️ ";
  const filters = [];
  if (discount > 0) filters.push(`${discount}%+ off`);
  if (minPrice > 0 && maxPrice < 999999)
    filters.push(
      `₹${minPrice.toLocaleString()} - ₹${maxPrice.toLocaleString()}`,
    );
  else if (minPrice > 0) filters.push(`Min ₹${minPrice.toLocaleString()}`);
  else if (maxPrice < 999999)
    filters.push(`Under ₹${maxPrice.toLocaleString()}`);

  desc +=
    filters.length > 0
      ? filters.join(" • ")
      : "All best deals with filters applied";

  // Display short URL
  const shortUrl = link.length > 60 ? link.substring(0, 57) + "..." : link;

  // Update card
  document.getElementById("linkPreviewIcon").textContent = config.icon;
  document.getElementById("linkPreviewTitle").textContent = title;
  document.getElementById("linkPreviewDesc").textContent = desc;
  document.getElementById("linkPreviewUrl").textContent = shortUrl;
  document.getElementById("openLinkBtn").href = link;
  document.getElementById("generatedLinkUrl").value = link;

  // Show card with animation
  linkCard.style.display = "block";
  linkCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Copy link to clipboard
async function handleCopyLink() {
  const link = document.getElementById("generatedLinkUrl")?.value;
  const copyBtn = document.getElementById("copyLinkBtn");

  if (!link) {
    showError("No link to copy!");
    return;
  }

  try {
    await navigator.clipboard.writeText(link);

    // Visual feedback
    copyBtn.classList.add("copied");
    copyBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> <span>Copied!</span>';
    showSuccess("📋 Link copied to clipboard!");

    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> <span>Copy Link</span>';
    }, 2000);
  } catch (error) {
    // Fallback for older browsers
    const textArea = document.createElement("textarea");
    textArea.value = link;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
    showSuccess("📋 Link copied!");
  }
}

// Share link (Web Share API or fallback)
async function handleShareLink() {
  const link = document.getElementById("generatedLinkUrl")?.value;
  const title =
    document.getElementById("linkPreviewTitle")?.textContent ||
    "Check out this deal!";
  const query = document.getElementById("linkQuery")?.value || "products";

  if (!link) {
    showError("No link to share!");
    return;
  }

  const shareText = `🛍️ ${title}\n\n💰 Best deals with filters applied!\n\n🔗 Shop now: ${link}\n\n📱 Found via SmartDeals - Your Smart Shopping Companion`;

  // Check if Web Share API is available
  if (navigator.share) {
    try {
      await navigator.share({
        title: title,
        text: `🛍️ Check out ${query} deals!`,
        url: link,
      });
      showSuccess("Shared successfully! 🎉");
    } catch (error) {
      if (error.name !== "AbortError") {
        // User cancelled share, try copy fallback
        handleCopyLink();
      }
    }
  } else {
    // Fallback: Open share options popup
    openSharePopup(link, title, shareText);
  }
}

// Share popup for desktop/unsupported browsers
function openSharePopup(link, title, shareText) {
  const encodedUrl = encodeURIComponent(link);
  const encodedTitle = encodeURIComponent(title);
  const encodedText = encodeURIComponent(shareText);

  // Create share modal
  const modal = document.createElement("div");
  modal.className = "share-modal";
  modal.innerHTML = `
        <div class="share-modal-content glass">
            <div class="share-modal-header">
                <h3>📤 Share This Deal</h3>
                <button class="share-modal-close">&times;</button>
            </div>
            <div class="share-options">
                <a href="https://wa.me/?text=${encodedText}" target="_blank" class="share-option whatsapp">
                    <span class="share-icon">💬</span>
                    <span>WhatsApp</span>
                </a>
                <a href="https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodeURIComponent("🛍️ " + title + " - Best deals!")}" target="_blank" class="share-option twitter">
                    <span class="share-icon">🐦</span>
                    <span>Twitter</span>
                </a>
                <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}" target="_blank" class="share-option linkedin">
                    <span class="share-icon">💼</span>
                    <span>LinkedIn</span>
                </a>
                <a href="https://t.me/share/url?url=${encodedUrl}&text=${encodedTitle}" target="_blank" class="share-option telegram">
                    <span class="share-icon">✈️</span>
                    <span>Telegram</span>
                </a>
                <a href="mailto:?subject=${encodedTitle}&body=${encodedText}" class="share-option email">
                    <span class="share-icon">📧</span>
                    <span>Email</span>
                </a>
                <button class="share-option copy" onclick="handleCopyLink(); this.closest('.share-modal').remove();">
                    <span class="share-icon">📋</span>
                    <span>Copy Link</span>
                </button>
            </div>
        </div>
    `;

  document.body.appendChild(modal);

  // Close handlers
  modal.querySelector(".share-modal-close").onclick = () => modal.remove();
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };

  // Add modal styles
  addShareModalStyles();
}

// Add share modal styles dynamically
function addShareModalStyles() {
  if (document.getElementById("share-modal-styles")) return;

  const style = document.createElement("style");
  style.id = "share-modal-styles";
  style.textContent = `
        .share-modal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 9999; animation: fadeIn 0.2s ease; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .share-modal-content { background: var(--bg-card); padding: 24px; border-radius: 16px; max-width: 400px; width: 90%; animation: slideUp 0.3s ease; }
        .share-modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .share-modal-header h3 { margin: 0; font-size: 18px; color: var(--text-primary); }
        .share-modal-close { font-size: 28px; color: var(--text-muted); background: none; border: none; cursor: pointer; line-height: 1; }
        .share-modal-close:hover { color: var(--text-primary); }
        .share-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .share-option { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 12px; background: var(--bg-elevated); border-radius: 12px; color: var(--text-primary); font-size: 13px; font-weight: 500; text-decoration: none; transition: all 0.2s; border: none; cursor: pointer; }
        .share-option:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .share-icon { font-size: 24px; }
        .share-option.whatsapp:hover { background: #25D366; color: white; }
        .share-option.twitter:hover { background: #1DA1F2; color: white; }
        .share-option.linkedin:hover { background: #0077B5; color: white; }
        .share-option.telegram:hover { background: #0088cc; color: white; }
        .share-option.email:hover { background: var(--accent); color: white; }
        .share-option.copy:hover { background: var(--gradient-success); color: white; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `;
  document.head.appendChild(style);
}

// Initialize link generator when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  initLinkGenerator();
  initCategoryWizard();

  // Add scroll animations for product cards
  const observerOptions = {
    threshold: 0.1,
    rootMargin: "0px 0px -50px 0px",
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = "1";
        entry.target.style.transform = "translateY(0)";
      }
    });
  }, observerOptions);

  // Observe product cards when they're added
  const productObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.classList && node.classList.contains("product-card")) {
          node.style.opacity = "0";
          node.style.transform = "translateY(30px)";
          node.style.transition = "opacity 0.6s ease, transform 0.6s ease";
          observer.observe(node);
        }
      });
    });
  });

  const productsGrid = document.getElementById("productsGrid");
  if (productsGrid) {
    productObserver.observe(productsGrid, { childList: true });
  }
});

// ===== Telegram Bot Popup =====
const TELEGRAM_POPUP_KEY = "smartdeals_telegram_popup_shown";
const TELEGRAM_POPUP_DELAY = 15000; // 15 seconds after page load

function showTelegramPopup() {
  const popup = document.getElementById("telegramPopup");
  if (popup) {
    popup.style.display = "block";
  }
}

function closeTelegramPopup() {
  const popup = document.getElementById("telegramPopup");
  if (popup) {
    popup.style.display = "none";
    // Remember that user closed it (don't show for 24 hours)
    try {
      localStorage.setItem(TELEGRAM_POPUP_KEY, Date.now().toString());
    } catch (e) {}
  }
}

function shouldShowTelegramPopup() {
  try {
    const lastShown = localStorage.getItem(TELEGRAM_POPUP_KEY);
    if (!lastShown) return true;
    // Show again after 24 hours
    const hoursSinceShown =
      (Date.now() - parseInt(lastShown)) / (1000 * 60 * 60);
    return hoursSinceShown >= 24;
  } catch (e) {
    return true;
  }
}

// Show popup after delay if user hasn't dismissed it recently
if (shouldShowTelegramPopup()) {
  setTimeout(showTelegramPopup, TELEGRAM_POPUP_DELAY);
}
