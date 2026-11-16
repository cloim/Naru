export const PROJECT_LABEL = 'com.docker.compose.project';
export const SERVICE_LABEL = 'com.docker.compose.service';

/**
 * Checks whether a container is locked against pruning.
 * Mirrors the backend logic in crates/core/src/containers.rs.
 *
 * @param {Set<string>|Array<string>} locks
 * @param {object} container
 * @returns {boolean}
 */
export function isContainerLocked(locks, container) {
  if (!locks || !container) return false;
  const lockSet = locks instanceof Set ? locks : new Set(locks);

  // 1. Check Full ID and Short ID
  const id = container.Id || container.id || '';
  if (id) {
    if (lockSet.has(id)) return true;
    if (id.length >= 12 && lockSet.has(id.slice(0, 12))) return true;
  }

  // 2. Check Names (/name and trimmed name)
  const names = Array.isArray(container.Names)
    ? container.Names
    : typeof container.Name === 'string'
      ? [container.Name]
      : [];

  for (const n of names) {
    if (typeof n === 'string') {
      const clean = n.replace(/^\//, '');
      if (lockSet.has(n) || lockSet.has(clean)) return true;
    }
  }

  // 3. Check Compose Project Label
  const labels = container.Labels || container.Config?.Labels || {};
  const proj = labels[PROJECT_LABEL];
  if (proj) {
    if (lockSet.has(proj) || lockSet.has(`project:${proj}`)) return true;
  }

  return false;
}

/**
 * Returns all identifier targets associated with a container to lock/unlock persistently.
 *
 * @param {object} container
 * @returns {string[]}
 */
export function getContainerLockTargets(container) {
  if (!container) return [];
  const targets = new Set();
  const id = container.Id || container.id;
  if (id) {
    targets.add(id);
    if (id.length >= 12) targets.add(id.slice(0, 12));
  }

  const names = Array.isArray(container.Names)
    ? container.Names
    : typeof container.Name === 'string'
      ? [container.Name]
      : [];

  for (const n of names) {
    if (typeof n === 'string' && n.trim()) {
      const clean = n.replace(/^\//, '');
      targets.add(clean);
      targets.add(n);
    }
  }

  return Array.from(targets);
}

/**
 * Returns all targets needed to lock/unlock an entire compose project.
 *
 * @param {string} projectName
 * @param {Array<object>} [members]
 * @returns {string[]}
 */
export function getProjectLockTargets(projectName, members = []) {
  if (!projectName) return [];
  const targets = new Set([`project:${projectName}`, projectName]);

  for (const c of members) {
    for (const t of getContainerLockTargets(c)) {
      targets.add(t);
    }
  }

  return Array.from(targets);
}

/**
 * Checks whether an entire compose project is considered locked.
 *
 * @param {Set<string>|Array<string>} locks
 * @param {string} projectName
 * @param {Array<object>} [members]
 * @returns {boolean}
 */
export function isProjectLocked(locks, projectName, members = []) {
  if (!locks || !projectName) return false;
  const lockSet = locks instanceof Set ? locks : new Set(locks);

  if (lockSet.has(`project:${projectName}`) || lockSet.has(projectName)) {
    return true;
  }

  if (members.length > 0 && members.every((c) => isContainerLocked(lockSet, c))) {
    return true;
  }

  return false;
}
