from langchain_text_splitters import RecursiveCharacterTextSplitter

_splitter = RecursiveCharacterTextSplitter(
    chunk_size=600,
    chunk_overlap=100,
    separators=["\n\n", "\n", ". ", " ", ""],
)


def chunk_runbook(title: str, body: str) -> list[str]:
    """Each chunk is prefixed with the title so retrieval surfaces titled context."""
    raw = _splitter.split_text(body)
    return [f"# {title}\n\n{chunk}" for chunk in raw] or [f"# {title}\n\n{body[:600]}"]
