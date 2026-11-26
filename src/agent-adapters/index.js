// AI CLI 어댑터 레지스트리 및 전략(Provider + Fallback) 리졸버.

import { agyAdapter } from './agy.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';

const ADAPTERS = new Map([
  [agyAdapter.name, agyAdapter],
  [claudeAdapter.name, claudeAdapter],
  [codexAdapter.name, codexAdapter],
]);

export function listAgentProviders() {
  return [...ADAPTERS.keys()];
}

export function getAgentAdapter(provider = 'agy') {
  const key = String(provider || 'agy').trim().toLowerCase();
  const adapter = ADAPTERS.get(key);
  if (!adapter) {
    throw new Error(`지원하지 않는 AI 어댑터입니다: ${provider} (가능: ${listAgentProviders().join(', ')})`);
  }
  return adapter;
}

export function parseFallbackProviders(raw = '') {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveAdapterChain({ provider = 'agy', fallbackProviders = [] } = {}) {
  const names = [String(provider || 'agy').trim().toLowerCase(), ...fallbackProviders];
  const seen = new Set();
  const chain = [];
  for (const name of names) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    chain.push(getAgentAdapter(name));
  }
  return chain;
}

// 작업(label)별 프로바이더·모델 전략을 결정한다.
// 예: taskRoutes = { 'intent-router': { provider: 'agy', model: 'gemini-3.8-flash-low' }, 'error-analysis': { provider: 'claude', model: 'claude-sonnet-4-6' } }
export function resolveTaskStrategy({
  label = 'agent',
  overrideProvider = null,
  defaultProvider = 'agy',
  fallbackProviders = [],
  taskRoutes = {},
  providerModels = {},
  explicitModel = '',
  explicitEffort = '',
} = {}) {
  const route = taskRoutes[label] || {};
  const primaryProvider = (overrideProvider || route.provider || defaultProvider || 'agy').toLowerCase();
  const chain = resolveAdapterChain({ provider: primaryProvider, fallbackProviders });

  return chain.map((adapter, idx) => {
    const isPrimary = idx === 0;
    const model = isPrimary
      ? (overrideProvider ? (providerModels[adapter.name] || '') : (explicitModel || route.model || providerModels[adapter.name] || ''))
      : (providerModels[adapter.name] || '');
    const effort = adapter.name === 'agy'
      ? (isPrimary ? (explicitEffort || route.effort || '') : '')
      : '';
    return { adapter, model, effort };
  });
}

// 멘션 앞의 "[claude] ...", "[codex] ...", "[agy] ..." 접두어를 파싱한다.
export function parseProviderOverride(text = '') {
  const raw = String(text || '');
  const match = raw.match(/^\s*\[(agy|claude|codex)\]\s*/i);
  if (!match) {
    return { provider: null, text: raw };
  }
  return {
    provider: match[1].toLowerCase(),
    text: raw.slice(match[0].length),
  };
}
