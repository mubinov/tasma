import { Field } from "@base-ui/react/field";
import { useId, useRef, useState, type ReactNode } from "react";
import { devDomain } from "../lib/dev-domain";
import { XIcon } from "../lib/icons";
import { useNoticeStore } from "../store/notices";
import { FIELD_ERROR_CLASS, FIELD_HINT_CLASS, VALUE_CHIP_CLASS } from "./control-classes";

const NOT_A_DOMAIN = "Not a domain name.";

/*
 * The border follows `FIELD_BORDER_CLASS`, keyed on the input rather than on
 * the box: `focus-within` would also match a focused remove button.
 */
const BOX_CLASS
  = "mt-1.5 flex min-h-8 flex-wrap items-center gap-1 rounded-control border bg-surface px-1 py-0.5 not-data-invalid:border-graphic not-data-invalid:has-[input:focus]:border-focus data-invalid:border-signal";

// The minimum width moves the input to a line of its own before its placeholder is cut.
const INPUT_CLASS
  = "min-h-6 min-w-28 flex-1 bg-transparent px-1.5 text-sm text-text placeholder:text-dim focus-visible:outline-hidden";

// 24x24 on the 22px chip: the negative margins keep the target from growing the chip.
const REMOVE_CLASS
  = "-my-1 -mr-1.5 ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-control text-dim hover:text-text";

type DomainChipsProps = {
  domains: readonly string[];
  onChange: (domains: string[]) => void;
};

function announce(words: string): void {
  useNoticeStore.getState().announce(words);
}

/** The development domains: one chip for each domain, and an input that adds one on Enter or on a blur. */
export function DomainChips({ domains, onChange }: DomainChipsProps): ReactNode {
  const labelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);

  function add(afterBlur: boolean): void {
    if (text.trim() === "") {
      return;
    }

    const host = devDomain(text);
    if (host === null) {
      setInvalid(true);
      // After a blur, focus is on another control, so the words name the field.
      announce(afterBlur ? "Development domains: not a domain name." : NOT_A_DOMAIN);
      return;
    }

    setText("");
    if (domains.includes(host)) {
      announce(`${host} is already in the list.`);
      return;
    }

    onChange([...domains, host]);
    announce(`${host} added.`);
  }

  function remove(domain: string): void {
    onChange(domains.filter((entry) => entry !== domain));
    announce(`${domain} removed.`);
    inputRef.current?.focus();
  }

  return (
    <Field.Root invalid={invalid}>
      <Field.Label id={labelId} className="block text-sm text-dim">
        Development domains
      </Field.Label>
      <div data-invalid={invalid || undefined} className={BOX_CLASS}>
        {domains.length > 0 && (
          // WebKit drops the list role of a list with `list-style: none`.
          <ul role="list" aria-labelledby={labelId} className="flex min-w-0 flex-wrap gap-1">
            {domains.map((domain) => (
              <li key={domain} className={`${VALUE_CHIP_CLASS} max-w-full min-w-0`}>
                {domain}
                <button
                  type="button"
                  onClick={() => {
                    remove(domain);
                  }}
                  className={REMOVE_CLASS}
                >
                  <XIcon size={12} aria-hidden="true" />
                  <span className="sr-only">{`Remove ${domain}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Field.Control
          ref={inputRef}
          value={text}
          onValueChange={(next) => {
            setText(next);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              add(false);
            }
          }}
          onBlur={() => {
            // A switch to another app keeps a half-typed domain in the field.
            if (document.hasFocus()) {
              add(true);
            }
          }}
          placeholder="Add a domain"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className={INPUT_CLASS}
        />
      </div>
      {invalid && <Field.Error match className={FIELD_ERROR_CLASS}>{NOT_A_DOMAIN}</Field.Error>}
      <Field.Description className={`mt-1.5 ${FIELD_HINT_CLASS}`}>
        Press Enter to add. A domain also covers its subdomains.
      </Field.Description>
    </Field.Root>
  );
}
