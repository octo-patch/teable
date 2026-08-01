import emojiData from '@emoji-mart/data';
import EmojiPickerCom from '@emoji-mart/react';
import { useTheme } from '@teable/next-themes';
import { Button, cn, Popover, PopoverContent, PopoverTrigger } from '@teable/ui-lib';
import { useTranslation } from 'next-i18next';
import type { CSSProperties, FC, PropsWithChildren } from 'react';
import { useEffect, useRef, useState } from 'react';

const PLACE_MAX_ATTEMPTS = 20;

const HIDDEN_STYLE: CSSProperties = { visibility: 'hidden' };

interface IEmojiPicker {
  className?: string;
  disabled?: boolean;
  icon?: string | null;
  onChange?: (emoji: string) => void;
  onRemove?: () => void;
}

export const EmojiPicker: FC<PropsWithChildren<IEmojiPicker>> = (props) => {
  const { children, className, icon, onChange, onRemove, disabled } = props;
  const { resolvedTheme } = useTheme();
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [removeButtonStyle, setRemoveButtonStyle] = useState<CSSProperties | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const showRemove = Boolean(icon && onRemove);

  // The picker UI lives inside em-emoji-picker's shadow DOM, which offers no slot
  // for extra controls. To place the remove button beside the search box, reserve
  // space at the right of the shadow `.search` element via an injected style, then
  // overlay our button there.
  useEffect(() => {
    if (!open || !showRemove) {
      setRemoveButtonStyle(null);
      return;
    }
    let attempts = 0;
    let rafId: number;
    const placeRemoveButton = () => {
      const wrapper = wrapperRef.current;
      const shadowRoot = wrapper?.querySelector('em-emoji-picker')?.shadowRoot;
      const search = shadowRoot?.querySelector('.search');
      const searchRow = search?.parentElement;
      const buttonWidth = removeButtonRef.current?.offsetWidth;
      if (!wrapper || !shadowRoot || !search || !searchRow || !buttonWidth) {
        if (attempts < PLACE_MAX_ATTEMPTS) {
          attempts++;
          rafId = requestAnimationFrame(placeRemoveButton);
        }
        return;
      }
      // Keep re-runs idempotent: dedupe the injected style and measure against
      // the search row, whose width is not affected by the reserved margin.
      if (!shadowRoot.querySelector('style[data-remove-reserve]')) {
        const style = document.createElement('style');
        style.setAttribute('data-remove-reserve', '');
        style.textContent = `.search { margin-inline-end: ${buttonWidth + 8}px; }`;
        shadowRoot.appendChild(style);
      }
      const wrapperRect = wrapper.getBoundingClientRect();
      const searchRect = search.getBoundingClientRect();
      const searchRowRect = searchRow.getBoundingClientRect();
      // The popover opening animation scales the content, so normalize the
      // measured rects back to layout coordinates.
      const scale = wrapperRect.width / wrapper.offsetWidth || 1;
      setRemoveButtonStyle({
        top: (searchRect.top - wrapperRect.top) / scale,
        right: (wrapperRect.right - searchRowRect.right) / scale,
        height: searchRect.height / scale,
      });
    };
    rafId = requestAnimationFrame(placeRemoveButton);
    return () => cancelAnimationFrame(rafId);
  }, [open, showRemove]);

  if (disabled) {
    return <div className={cn('rounded transition-colors', className)}>{children}</div>;
  }

  const onEmojiSelect = (emoji: { native: string }) => {
    onChange?.(emoji.native);
    setOpen(false);
  };

  const onRemoveClick = () => {
    onRemove?.();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className={cn('rounded transition-colors', className)}>{children}</div>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0">
        <div ref={wrapperRef} className="relative">
          <EmojiPickerCom theme={resolvedTheme} data={emojiData} onEmojiSelect={onEmojiSelect} />
          {showRemove && (
            <Button
              ref={removeButtonRef}
              variant="secondary"
              size="sm"
              style={removeButtonStyle ?? HIDDEN_STYLE}
              className="absolute right-0 top-0 px-3 text-[13px] text-muted-foreground hover:text-foreground"
              onClick={onRemoveClick}
            >
              {t('actions.remove')}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
