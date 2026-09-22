> For clean Markdown content of this page, append .md to this URL. For the complete documentation index, see https://docs.agentmail.to/llms.txt. For full content including API reference and SDK examples, see https://docs.agentmail.to/llms-full.txt.

# Attachments

> Learn how to send files as attachments, and download incoming attachments from both messages and threads.

## What are `Attachments`?

An `Attachment` is a file that is associated with a `Message`. This can be anything from a PDF invoice to a CSV report or an image(though we don't recommend sending images in the first email sent. We go more into this in the [deliverability section](/email-deliverability)). Your agents can both send `Attachments` in outgoing `Messages` and process `Attachments` from incoming `Messages`.

## Sending `Attachments`

To send a file, include it in the `attachments` array when sending a `Message`. Each object in the array represents one file and must provide either `content` or `url`.

* **`content`**: The Base64 encoded content of your file.
* **`url`**: A URL that AgentMail can download without custom authentication headers or cookies. Redirects and pre-signed URLs are supported, and the final response must be a successful `2xx` response.
* **`filename`** (optional): The name of the file (e.g., `invoice.pdf`).
* **`content_type`** (optional): The MIME type of the file (e.g., `application/pdf`).

### Attachment size limits

| Input            | Limit                                   | What counts toward the limit                                                   |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| Inline `content` | 6 MB per request                        | The entire request, including the message body, metadata, and all attachments. |
| Remote `url`     | Around 30 MB of attachments per message | The combined size of the files AgentMail downloads from all attachment URLs.   |

If an inline request exceeds 6 MB, the API returns `413 Request Entity Too Large`. For larger files, use URL-backed attachments and keep the combined attachment size around 30 MB per message.

To detect the inline limit proactively, measure the complete serialized request and leave room for the message body and metadata. Use `url` for larger attachments.

```python
import base64

# A simple text file for this example

file_content = "This is the content of our report."

# You must Base64 encode the file content before sending

encoded_content = base64.b64encode(file_content.encode()).decode()

sent_message = client.inboxes.messages.send(
inbox_id="reports@agentmail.to",
to=["supervisor@example.com"],
subject="Q4 Financial Report",
text="Please see the attached report.",
attachments=[{
"content": encoded_content,
"filename": "Q4-report.txt",
"content_type": "text/plain"
}]
)

```

**`TypeScript`**

```typescript title="TypeScript"
// A simple text file for this example
const fileContent = "This is the content of our report.";
// You must Base64 encode the file content before sending
const encodedContent = Buffer.from(fileContent).toString("base64");

const sentMessage = await client.inboxes.messages.send("reports@agentmail.to", {
  to: ["supervisor@example.com"],
  subject: "Q4 Financial Report",
  text: "Please see the attached report.",
  attachments: [{
    content: encodedContent,
    filename: "Q4-report.txt",
    contentType: "text/plain",
  }],
});
```

**`CLI`**

```bash title="CLI"
# send a message with a base64-encoded attachment
agentmail inboxes messages send \
  --inbox-id reports@agentmail.to \
  --to supervisor@example.com \
  --subject "Q4 Financial Report" \
  --text "Please see the attached report." \
  --attachments '[{"filename": "Q4-report.txt", "content_type": "text/plain", "content": "VGhpcyBpcyB0aGUgY29udGVudCBvZiBvdXIgcmVwb3J0Lg=="}]'
```

## Retrieving `Attachments`

To retrieve an `Attachment`, you first need its `attachment_id`. You can get this ID from the `attachments` array on a `Message` object. Once you have the ID, you can download the file.

The API response for getting an attachment is the raw file itself, which you can then save to disk or process in memory.

### From a Specific `Message`

If you know the `Message` an `Attachment` belongs to, you can retrieve it directly.

```python
inbox_id = "inbox_123"
message_id = "<def456@agentmail.to>"
attachment_id = "attach_789" # From the message object

file_data = client.inboxes.messages.get_attachment(
inbox_id=inbox_id,
message_id=message_id,
attachment_id=attachment_id
)

# Now you can save the file

with open("downloaded_file.pdf", "wb") as f:
f.write(file_data)

```

**`TypeScript`**

```typescript title="TypeScript"
const inboxId = "inbox_123";
const messageId = "<def456@agentmail.to>";
const attachmentId = "attach_789"; // From the message object

const fileData = await client.inboxes.messages.get_attachment(
  inboxId,
  messageId,
  attachmentId
);

// fileData is a Blob/Buffer that you can process
// For example, in Node.js:
// import fs from 'fs';
// fs.writeFileSync('downloaded_file.pdf', fileData);
```

**`CLI`**

```bash title="CLI"
# get an attachment from a specific message
agentmail inboxes messages get-attachment \
  --inbox-id inbox_123 \
  --message-id "<def456@agentmail.to>" \
  --attachment-id attach_789
```

### From a Specific `Thread`

Similarly, you can retrieve an `Attachment` if you know the `Thread` it's in, which can be more convenient for multi-message conversations.

```python
inbox_id = "inbox_123"
thread_id = "thread_abc"
attachment_id = "attach_789" # From a message within the thread

file_data = client.inboxes.threads.get_attachment(
inbox_id=inbox_id,
thread_id=thread_id,
attachment_id=attachment_id
)

```

**`TypeScript`**

```typescript title="TypeScript"
const inboxId = "inbox_123";
const threadId = "thread_abc";
const attachmentId = "attach_789"; // From a message within the thread

const fileData = await client.inboxes.threads.get_attachment(
  inboxId,
  threadId,
  attachmentId
);
```

**`CLI`**

```bash title="CLI"
# get an attachment from a specific thread
agentmail inboxes threads get-attachment \
  --inbox-id inbox_123 \
  --thread-id thread_abc \
  --attachment-id attach_789
```

## Copy for Cursor / Claude

Copy one of the blocks below into Cursor or Claude for complete Attachments usage in one shot.

**`Python`**

```python title="Python"
"""
AgentMail Attachments — copy into Cursor/Claude.

Send: attachments=[{ content: base64_string, filename?, content_type? }] in messages.send/reply.
Get attachment_id from message.attachments or thread.attachments.

- messages.get_attachment(inbox_id, message_id, attachment_id) → bytes
- threads.get_attachment(inbox_id, thread_id, attachment_id) → bytes
"""
import base64
from agentmail import AgentMail

client = AgentMail(api_key="YOUR_API_KEY")

encoded = base64.b64encode(b"file content").decode()
client.inboxes.messages.send(
  "agent@agentmail.to",
  to="user@example.com",
  subject="Report",
  text="See attachment",
  attachments=[{"content": encoded, "filename": "report.txt", "content_type": "text/plain"}],
)

data = client.inboxes.messages.get_attachment("inbox@am.to", "<abc123@agentmail.to>", "att_456")
with open("downloaded.pdf", "wb") as f:
  f.write(data)
```

**`TypeScript`**

```typescript title="TypeScript"
/**
 * AgentMail Attachments — copy into Cursor/Claude.
 *
 * Send: attachments: [{ content: base64String, filename?, contentType? }] in messages.send/reply.
 * Get attachmentId from message.attachments or thread.attachments.
 *
 * - messages.get_attachment(inboxId, messageId, attachmentId) → Buffer/Blob
 * - threads.get_attachment(inboxId, threadId, attachmentId) → Buffer/Blob
 */
import { AgentMailClient } from "agentmail";

const client = new AgentMailClient({ apiKey: "YOUR_API_KEY" });

const encoded = Buffer.from("file content").toString("base64");
await client.inboxes.messages.send("agent@agentmail.to", {
  to: "user@example.com",
  subject: "Report",
  text: "See attachment",
  attachments: [{ content: encoded, filename: "report.txt", contentType: "text/plain" }],
});

const data = await client.inboxes.messages.get_attachment("inbox@am.to", "<abc123@agentmail.to>", "att_456");
```