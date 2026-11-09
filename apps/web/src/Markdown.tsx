import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Links in a reply open in a new tab, and never tell the site where they came from.
const components: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

/** A Bot's reply, as the model wrote it: Markdown, with tables and task lists. Raw HTML stays text. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
