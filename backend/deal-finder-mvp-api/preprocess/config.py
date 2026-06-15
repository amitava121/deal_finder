"""
Configuration loader for preprocessing engine (Steps 1-5)
Reads from main project .env file
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from main project .env
project_root = Path(__file__).parent.parent.parent
env_path = project_root / '.env'

if env_path.exists():
    load_dotenv(env_path)
else:
    # Try loading from current directory as fallback
    load_dotenv()

# Pipeline Settings
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')

def get_config():
    """Get configuration dictionary"""
    return {
        'log_level': LOG_LEVEL
    }

def validate_config():
    """Validate that required configuration is present"""
    errors = []

    if errors:
        raise ValueError(f"Configuration validation failed:\n" + "\n".join(f"  - {e}" for e in errors))

    return True
