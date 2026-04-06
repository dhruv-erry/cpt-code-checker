"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  parseContextIdFromInput,
  parseDepartmentsInput,
  type SpecificOrgConfig,
  validateContextIdInput,
  validateDepartmentsInput,
} from "@/lib/cptOrgConfig";

export type SpecificOrgDialogProps = {
  open: boolean;
  initialContextId: string;
  initialDepartments: string;
  onConfirm: (config: SpecificOrgConfig) => void;
  onCancel: () => void;
};

export function SpecificOrgDialog({
  open,
  initialContextId,
  initialDepartments,
  onConfirm,
  onCancel,
}: SpecificOrgDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [contextField, setContextField] = useState(initialContextId);
  const [departmentsField, setDepartmentsField] = useState(initialDepartments);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setContextField(initialContextId);
      setDepartmentsField(initialDepartments);
      setSubmitError(null);
    }
  }, [open, initialContextId, initialDepartments]);

  useEffect(() => {
    if (!open) return;

    function focusables(): HTMLElement[] {
      const root = panelRef.current;
      if (!root) return [];
      const nodes = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      return Array.from(nodes).filter(
        (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
      );
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;

      const list = focusables();
      if (list.length === 0) return;

      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const handleFocusIn = (e: FocusEvent) => {
      const root = panelRef.current;
      const t = e.target;
      if (!root || !(t instanceof Node) || root.contains(t)) return;
      const list = focusables();
      list[0]?.focus();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    const id = requestAnimationFrame(() => {
      const firstInput = panelRef.current?.querySelector<HTMLInputElement>(
        "input[type=text], input:not([type])",
      );
      firstInput?.focus();
    });

    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [open, onCancel]);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ctxErr = validateContextIdInput(contextField);
    const deptErr = validateDepartmentsInput(departmentsField);
    if (ctxErr) {
      setSubmitError(ctxErr);
      return;
    }
    if (deptErr) {
      setSubmitError(deptErr);
      return;
    }
    try {
      const contextId = parseContextIdFromInput(contextField);
      const departmentIds = parseDepartmentsInput(departmentsField);
      onConfirm({ contextId, departmentIds });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Invalid input.");
    }
  }

  return (
    <div
      className="aqua-sheet__backdrop"
      role="presentation"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        className="aqua-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(ev) => ev.stopPropagation()}
      >
        <div className="aqua-sheet__title-strip">
          <h2 id={titleId} className="aqua-sheet__title">
            Specific org settings
          </h2>
        </div>
        <form className="aqua-sheet__body" onSubmit={handleSubmit}>
          {/* Intro/logo intentionally removed (requested). */}

          <label className="aqua-sheet__field-label" htmlFor="aqua-context-id">
            Context ID
          </label>
          <input
            id="aqua-context-id"
            className="aqua-sheet__input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={contextField}
            onChange={(ev) => setContextField(ev.target.value)}
          />

          <label className="aqua-sheet__field-label" htmlFor="aqua-departments">
            Departments
          </label>
          <input
            id="aqua-departments"
            className="aqua-sheet__input"
            type="text"
            autoComplete="off"
            placeholder="e.g. 12, 34, 56"
            value={departmentsField}
            onChange={(ev) => setDepartmentsField(ev.target.value)}
          />

          {submitError ? <p className="aqua-sheet__error">{submitError}</p> : null}

          <div className="aqua-sheet__actions">
            <button type="button" className="aqua-sheet__btn aqua-sheet__btn--secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="aqua-sheet__btn aqua-sheet__btn--primary">
              OK
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
