/* ============================================================
   BoostSpeed – api.js
   Cliente HTTP centralizado para llamadas al backend
   ============================================================ */
const API = {
  // ── Llamadas de usuario autenticado ──────────────────────
  async post(url, body) {
    try {
      const token = localStorage.getItem('bs_token');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Error de conexión. Verifica tu internet.' };
    }
  },

  async get(url) {
    try {
      const token = localStorage.getItem('bs_token');
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Error de conexión.' };
    }
  },

  // ── Llamadas del administrador ───────────────────────────
  async getAdmin(url, token) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token },
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Error de conexión.' };
    }
  },

  async postAdmin(url, body, token) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Error de conexión.' };
    }
  },

  async putAdmin(url, body, token) {
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Error de conexión.' };
    }
  },

  async deleteAdmin(url, token) {
    try {
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'Error de conexión.' };
    }
  },
};
