# Frontend localization

- Keep all user-facing frontend copy in French.
- Never render backend or upstream error messages directly. Translate stable API error codes at the frontend boundary and use a generic French fallback for unknown codes or malformed error responses.
- Add or update frontend tests whenever error-code translations change.
