"use client";

import { useEffect, useRef, useState } from "react";
import type { ZodType } from "zod";
import { requestErrorMessage, requestFlagData } from "./flag-api";

/** Keep the last successful snapshot while a new query is in flight. */
export function useFlagResource<T>(url: string, initialData: T, schema: ZodType<T>) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    setData(initialData);
  }, [initialData]);

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    void requestFlagData(url, schema, { signal: controller.signal })
      .then((next) => {
        if (!controller.signal.aborted && current === generation.current) setData(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && current === generation.current) {
          setError(requestErrorMessage(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && current === generation.current) setLoading(false);
      });
    return () => controller.abort();
  }, [url, schema, revision]);

  return { data, loading, error, refresh: () => setRevision((value) => value + 1) };
}
