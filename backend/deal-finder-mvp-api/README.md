# Deal Finder MVP API

Simple FastAPI backend for Deal Finder MVP.

## Features

- POST /search endpoint
- Amazon and Flipkart URL support
- Basic product name extraction from URL
- Async alternative lookup
- In-memory cache with 10 minute TTL
- CORS enabled for frontend integration

## Project files

- main.py: FastAPI app and /search endpoint
- search.py: mock alternative product search logic
- utils.py: platform detection and query helpers
- cache.py: TTL cache with auto cleanup

## Local setup

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

API base URL: http://127.0.0.1:8000

## Quick API test

Request:

```http
POST /search
Content-Type: application/json

{
	"url": "https://www.amazon.in/dp/B0Example"
}
```

Response:

```json
[
	{
		"name": "Product Name",
		"price": 1499,
		"link": "https://www.amazon.in/s?k=product"
	}
]
```

## Deploy on Render (free tier)

1. Push this folder to a GitHub repo.
2. Create a new Web Service in Render.
3. Select Python runtime.
4. Build command:

```bash
pip install -r requirements.txt
```

5. Start command:

```bash
uvicorn main:app --host 0.0.0.0 --port 10000
```

6. Deploy and copy the service URL.

## Notes

- Cache is in memory only. Data resets on restart.
- This MVP uses mock alternatives in search.py.
