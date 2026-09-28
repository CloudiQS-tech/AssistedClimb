type LinkifiedTextProps = {
  text: string;
  className?: string;
};

export function LinkifiedText({ text, className }: LinkifiedTextProps) {
  const parts = text.split(/(https?:\/\/\S+)/g);

  return (
    <span className={className}>
      {parts.map((part, index) => {
        if (!/^https?:\/\//.test(part)) return part;
        const match = part.match(/^(.*?)([.,;!?]+)?$/);
        const href = match?.[1] ?? part;
        const trailing = match?.[2] ?? "";
        return (
          <span key={`${href}-${index}`}>
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline underline-offset-2 hover:text-sky-900">
              {href}
            </a>
            {trailing}
          </span>
        );
      })}
    </span>
  );
}