# M16 multi-file fixture

[valid file](docs/guide.md), [broken file](docs/missing.md)
[valid image](images/logo.png), ![broken image](images/missing.png)
[same anchor](#m16-multi-file-fixture), [broken same anchor](#missing-anchor)
[cross anchor](docs/guide.md#installation), [broken cross anchor](docs/guide.md#deployment)
[explicit html anchor](docs/guide.md#explicit-target)
<a href="docs/api.md">raw valid link</a> and <a href="docs/missing-raw.md">raw broken link</a>
<img src="images/logo.png" alt="raw valid image"> and <img src="images/missing-raw.png" alt="raw broken image">
[valid reference][api-ref] and [broken reference][broken-ref]
[external success](https://example.com/ok), [external failure](https://example.com/fail), [external failure duplicate](https://example.com/fail)
![external image](https://example.com/ok)

## Duplicate

## Duplicate

[duplicate first](#duplicate), [duplicate second](#duplicate-1), [broken duplicate](#duplicate-2)

<a id="explicit-one"></a>

## Details

[explicit-one](#explicit-one)

[api-ref]: docs/api.md
[broken-ref]: docs/missing-ref.md

```text
[fenced](missing-fenced.md)
```

Inline `[code](missing-inline.md)` and [back to top](#m16-multi-file-fixture).
