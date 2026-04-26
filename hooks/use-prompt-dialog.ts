import { useState, useCallback, useRef, useEffect } from "react";

interface PromptDialogState {
  isOpen: boolean;
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue: string;
  confirmText?: string;
  cancelText?: string;
  onSubmit: (value: string) => void;
}

const INITIAL_STATE: PromptDialogState = {
  isOpen: false,
  title: "",
  defaultValue: "",
  onSubmit: () => {},
};

interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}

export function usePromptDialog() {
  const [state, setState] = useState<PromptDialogState>(INITIAL_STATE);
  const resolveRef = useRef<((value: string | null) => void) | null>(null);

  useEffect(() => {
    return () => {
      if (resolveRef.current) {
        resolveRef.current(null);
        resolveRef.current = null;
      }
    };
  }, []);

  const prompt = useCallback(
    (options: PromptOptions): Promise<string | null> => {
      return new Promise((resolve) => {
        resolveRef.current = resolve;
        setState({
          isOpen: true,
          title: options.title,
          message: options.message,
          placeholder: options.placeholder,
          defaultValue: options.defaultValue ?? "",
          confirmText: options.confirmText,
          cancelText: options.cancelText,
          onSubmit: (value) => {
            resolveRef.current = null;
            resolve(value);
          },
        });
      });
    },
    []
  );

  const close = useCallback(() => {
    if (resolveRef.current) {
      resolveRef.current(null);
      resolveRef.current = null;
    }
    setState(INITIAL_STATE);
  }, []);

  return {
    dialogProps: {
      isOpen: state.isOpen,
      onClose: close,
      onSubmit: state.onSubmit,
      title: state.title,
      message: state.message,
      placeholder: state.placeholder,
      defaultValue: state.defaultValue,
      confirmText: state.confirmText,
      cancelText: state.cancelText,
    },
    prompt,
  };
}
