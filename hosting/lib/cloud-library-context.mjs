// Scope internal integration checks without exposing a selectable library to callers.
const namespaceKey = Symbol('internal-library-namespace');

export function libraryNamespace(env) {
  return env?.[namespaceKey] ?? 'owner';
}

export function scopeEnvironment(env, namespace) {
  if (typeof namespace !== 'string' || !/^qa-image-[a-f0-9]{64}$/.test(namespace)) {
    throw new TypeError('Invalid internal verification namespace.');
  }
  return Object.assign(Object.create(env), { [namespaceKey]: namespace });
}
