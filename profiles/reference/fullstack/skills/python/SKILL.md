---
description: "Python development — async, typing, packaging, FastAPI/Flask, testing"
---
# Python Backend

## When to Use

- Building or modifying a FastAPI or Flask backend
- Setting up dependency management with Poetry
- Writing async handlers, type-checked code, or tests
- Configuring logging, linting, or deployment for a Python service

## Procedure

1. **Use Poetry for dependency management:**
   ```bash
   poetry init
   poetry add fastapi uvicorn[standard] pydantic
   poetry add --group dev pytest ruff mypy
   ```

2. **Define Pydantic models** for request/response validation:
   ```python
   from pydantic import BaseModel

   class UserCreate(BaseModel):
       email: str
       name: str
       age: int | None = None
   ```

3. **Use FastAPI dependency injection** for auth, DB sessions, and shared logic:
   ```python
   async def get_current_user(token: str = Depends(oauth2_scheme)):
       return await verify_token(token)
   ```

4. **Use async for I/O-bound work** — asyncpg, httpx, redis:
   ```python
   async def fetch_user(user_id: int):
       async with httpx.AsyncClient() as client:
           resp = await client.get(f"https://api/users/{user_id}")
           return resp.json()
   ```

5. **Run with uvicorn behind gunicorn** in production:
   ```bash
   gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker
   ```

6. **Use dataclasses** for plain data containers, Pydantic for API boundaries:
   ```python
   from dataclasses import dataclass

   @dataclass(frozen=True)
   class UserDTO:
       id: int
       email: str
   ```

7. **Add type hints and check with mypy:**
   ```bash
   mypy --strict src/
   ```

8. **Test with pytest** — fixtures, parametrize, and AsyncClient:
   ```python
   @pytest.mark.parametrize("email,valid", [("a@b.com", True), ("bad", False)])
   async def test_validate_email(email, valid):
       assert validate_email(email) is valid
   ```

9. **Use ruff** for both linting and formatting (replaces flake8 + black + isort):
   ```bash
   ruff check --fix src/ && ruff format src/
   ```

10. **Log with structlog** for structured JSON output in production.

## Pitfalls

- Using `requests` (sync) inside async handlers blocks the event loop — use `httpx.AsyncClient`
- Forgetting `await` on async calls returns a coroutine, not the result
- Poetry lockfile not committed — reproducible builds break
- `mypy` not running in CI — type hints drift from actual types

## Verification

- `poetry run pytest` passes with coverage ≥ 80%
- `mypy --strict src/` reports zero errors
- `ruff check src/` is clean
- Uvicorn starts and `/docs` shows the OpenAPI schema
- No sync HTTP calls inside async functions (`grep -r "requests\." src/`)
