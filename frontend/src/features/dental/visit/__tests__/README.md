# Resolver checks

`focusVisit.check.ts` covers `resolveFocus` — the ladder that decides which visit the
dental patient page is about. It is plain assertions with no test-runner dependency,
because the frontend has none; run it with esbuild + node:

```
cd frontend
npx esbuild src/features/dental/visit/__tests__/focusVisit.check.ts \
  --bundle --platform=node --format=esm --alias:@=./src --outfile=/tmp/focus.mjs
node /tmp/focus.mjs
```

The case that matters most is #2: a patient mid-course with nothing booked today must
still resolve to their open session. The page this replaced filtered by date first and
landed such a patient on the History tab, showing a finished treatment from last year.
