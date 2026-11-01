/**
 * 工具装配：把所有域注册进一个 registry
 */

import { createRegistry } from './registry.js';
import { registerQqTools } from './qq.js';
import { registerQqMoreTools } from './qq-more.js';
import { registerQqExtraTools } from './qq-extra.js';
import { registerQzoneTools } from './qzone.js';

export function createToolRegistry() {
  const registry = createRegistry();
  registerQqTools(registry);
  registerQqMoreTools(registry);
  registerQqExtraTools(registry);
  registerQzoneTools(registry);
  return registry;
}

export { createRegistry };
