/**
 * 工具装配：把所有域注册进一个 registry
 */

import { createRegistry } from './registry.js';
import { registerQqTools } from './qq.js';

export function createToolRegistry() {
  const registry = createRegistry();
  registerQqTools(registry);
  return registry;
}

export { createRegistry };
