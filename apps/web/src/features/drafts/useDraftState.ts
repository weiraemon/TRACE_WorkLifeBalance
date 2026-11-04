import {
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';

const prefix = 'chaos.form-draft.v1:';
let durable = true;
export const draftsAreDurable = () => durable;
const pending = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// A form can unmount during a save. Its submission remains busy until publication finishes.
export function useDraftSaving(key: string): [boolean, (busy: boolean) => void] {
  const busy = useSyncExternalStore(subscribe, () => pending.has(key));
  return [
    busy,
    (next) => {
      if (next) pending.add(key);
      else pending.delete(key);
      for (const listener of listeners) listener();
    },
  ];
}

export function clearDraft(key: string) {
  try {
    for (const name of Object.keys(localStorage))
      if (name.startsWith(prefix + key + ':')) {
        localStorage.removeItem(name);
        window.dispatchEvent(
          new CustomEvent('chaos-draft-change', { detail: { key: name, removed: true } }),
        );
      }
  } catch {
    durable = false;
    /* Draft storage may be unavailable in a restricted browser. */
  }
}

// Drafts stay on this device. Only an explicit save publishes workspace content.
export function useDraftState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const fallbackRef = useRef<T | undefined>(undefined);
  const [value, setValue] = useState<T>(() => {
    const fallback = initial instanceof Function ? initial() : initial;
    fallbackRef.current = fallback;
    try {
      const source = localStorage.getItem(prefix + key);
      if (source === null) return fallback;
      const saved = JSON.parse(source);
      if (Array.isArray(fallback))
        return Array.isArray(saved) && saved.every((item) => typeof item === 'string')
          ? saved
          : fallback;
      if (fallback && typeof fallback === 'object')
        return saved &&
          typeof saved === 'object' &&
          !Array.isArray(saved) &&
          Object.keys(fallback).every(
            (name) => typeof saved[name] === typeof (fallback as Record<string, unknown>)[name],
          )
          ? saved
          : fallback;
      return typeof saved === typeof fallback ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const current = useRef(value);
  current.current = value;
  useEffect(() => {
    const receive = (event: Event) => {
      const change = (event as CustomEvent).detail;
      if (change.key !== prefix + key) return;
      current.current = change.removed ? fallbackRef.current : change.value;
      setValue(current.current);
    };
    window.addEventListener('chaos-draft-change', receive);
    try {
      if (localStorage.getItem(prefix + key) === null)
        localStorage.setItem(prefix + key, JSON.stringify(current.current));
    } catch {
      durable = false;
      /* Keep the in-memory draft when local storage is full or disabled. */
    }
    return () => window.removeEventListener('chaos-draft-change', receive);
  }, [key]);
  return [
    value,
    (next) => {
      const updated = next instanceof Function ? next(current.current) : next;
      current.current = updated;
      try {
        localStorage.setItem(prefix + key, JSON.stringify(updated));
      } catch {
        durable = false;
      }
      setValue(updated);
      window.dispatchEvent(
        new CustomEvent('chaos-draft-change', { detail: { key: prefix + key, value: updated } }),
      );
    },
  ];
}
