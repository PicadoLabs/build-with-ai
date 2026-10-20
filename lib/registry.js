const REGISTRY_URL = 'https://raw.githubusercontent.com/PicadoLabs/build-with-ai/main/templates/index.json';

async function fetchRegistry({ url = REGISTRY_URL, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (Array.isArray(data)) return data;
    // Registry endpoints can return null or non-object payloads; guard the
    // .templates access so malformed payloads resolve to [] instead of
    // throwing an unhandled TypeError.
    return data && Array.isArray(data.templates) ? data.templates : [];
  } finally {
    clearTimeout(timer);
  }
}

function filterTemplates(templates, keyword) {
  const query = (keyword || '').toLowerCase();
  return templates.filter((t) => {
    return !query || [t.id, t.title, t.description].some((value) => String(value).toLowerCase().includes(query));
  });
}

module.exports = { REGISTRY_URL, fetchRegistry, filterTemplates };
