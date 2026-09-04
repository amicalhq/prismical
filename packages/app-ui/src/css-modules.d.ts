// Ambient declaration for side-effect CSS imports. The note
// editor imports its stylesheets for their side effect
// (`import "./note-body-editor.css"` etc). Web/desktop bundlers handle the
// import; this keeps app-ui's own `tsc --noEmit` from erroring on the module,
// standing in for the `declare module "*.css"` that Next's next-env.d.ts gives
// the web app.
declare module "*.css";
