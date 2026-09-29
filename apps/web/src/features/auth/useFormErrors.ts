import { useState } from "react";
import { ApiError } from "../../lib/api";

/** Maps API errors to a top-level message + per-field messages. */
export function useFormErrors() {
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  return {
    formError,
    fieldErrors,
    clear: () => { setFormError(null); setFieldErrors({}); },
    setFields: setFieldErrors,
    fromError: (err: unknown) => {
      if (err instanceof ApiError) {
        if (err.fields && Object.keys(err.fields).some((k) => k !== "_")) {
          setFieldErrors(err.fields);
          setFormError(err.code === "VALIDATION_ERROR" ? null : err.message);
        } else {
          setFieldErrors({});
          setFormError(err.message);
        }
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    },
  };
}
