import { describe, it, expect } from 'vitest';

/**
 * isTokenValid — JWT tokenning muddati o'tganligini tekshiradi.
 * Bu funksiya App.jsx ichida aniqlangan, test uchun qayta implement qilingan.
 */
const isTokenValid = (token) => {
  if (!token || typeof token !== 'string') return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return true;
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
};

/**
 * Helper: JWT token yaratish (signaturasiz, faqat test uchun)
 */
const createTestToken = (payload) => {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
};

describe('isTokenValid - JWT token muddati tekshiruvi', () => {
  it('bo\'sh yoki null token uchun false qaytaradi', () => {
    expect(isTokenValid(null)).toBe(false);
    expect(isTokenValid(undefined)).toBe(false);
    expect(isTokenValid('')).toBe(false);
  });

  it('noto\'g\'ri format (3 qismdan iborat bo\'lmagan) uchun false qaytaradi', () => {
    expect(isTokenValid('abc')).toBe(false);
    expect(isTokenValid('abc.def')).toBe(false);
    expect(isTokenValid('not-a-jwt')).toBe(false);
  });

  it('muddati o\'tgan token uchun false qaytaradi', () => {
    const expiredToken = createTestToken({
      sub: 'user123',
      exp: Math.floor(Date.now() / 1000) - 3600, // 1 soat oldin
    });
    expect(isTokenValid(expiredToken)).toBe(false);
  });

  it('haqiqiy (muddati o\'tmagan) token uchun true qaytaradi', () => {
    const validToken = createTestToken({
      sub: 'user123',
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 soatdan keyin
    });
    expect(isTokenValid(validToken)).toBe(true);
  });

  it('exp maydoni bo\'lmagan token uchun true qaytaradi (muddatsiz)', () => {
    const noExpToken = createTestToken({
      sub: 'user123',
      nickname: 'testuser',
    });
    expect(isTokenValid(noExpToken)).toBe(true);
  });

  it('decode qilib bo\'lmaydigan payload uchun false qaytaradi', () => {
    expect(isTokenValid('header.!!!invalid-base64!!!.signature')).toBe(false);
  });
});
