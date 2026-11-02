import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Pencil, Reply, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { UserAvatar } from "~/components/user-avatar";
import {
  formatCommentDate,
  MAX_COMMENT_LENGTH,
  splitCommentText,
} from "~/lib/comments";
import type {
  CommentAccess,
  LessonCommentView,
} from "~/services/lessonCommentService";

type CommentActionData = { ok: boolean; error: string | null };

function CommentForm({
  intent,
  commentId,
  parentId,
  initialContent = "",
  placeholder,
  submitLabel,
  onDone,
  onCancel,
}: {
  intent: "create-comment" | "update-comment";
  commentId?: number;
  parentId?: number;
  initialContent?: string;
  placeholder?: string;
  submitLabel: string;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const fetcher = useFetcher<CommentActionData>();
  const [content, setContent] = useState(initialContent);
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.ok) {
      setContent("");
      onDone?.();
    } else if (fetcher.data.error) {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <fetcher.Form method="post" className="space-y-2">
      <input type="hidden" name="intent" value={intent} />
      {commentId !== undefined && (
        <input type="hidden" name="commentId" value={commentId} />
      )}
      {parentId !== undefined && (
        <input type="hidden" name="parentId" value={parentId} />
      )}
      <Textarea
        name="content"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder ?? submitLabel}
        maxLength={MAX_COMMENT_LENGTH}
        rows={3}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {content.length}/{MAX_COMMENT_LENGTH}
        </span>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            disabled={isSubmitting || content.trim().length === 0}
          >
            {isSubmitting ? "Saving..." : submitLabel}
          </Button>
        </div>
      </div>
    </fetcher.Form>
  );
}

function CommentText({ content }: { content: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {splitCommentText(content).map((segment, index) =>
        segment.type === "link" ? (
          <a
            key={index}
            href={segment.value}
            target="_blank"
            rel="nofollow ugc noopener"
            className="text-primary underline underline-offset-2"
          >
            {segment.value}
          </a>
        ) : (
          <span key={index}>{segment.value}</span>
        )
      )}
    </p>
  );
}

function DeleteCommentButton({ commentId }: { commentId: number }) {
  const [confirming, setConfirming] = useState(false);
  const fetcher = useFetcher<CommentActionData>();

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.error) {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-destructive">Delete?</span>
        <Button
          variant="destructive"
          size="sm"
          className="h-6 text-xs"
          onClick={() => {
            fetcher.submit(
              { intent: "delete-comment", commentId: String(commentId) },
              { method: "post" }
            );
            setConfirming(false);
          }}
        >
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
      disabled={fetcher.state !== "idle"}
      onClick={() => setConfirming(true)}
    >
      <Trash2 className="mr-1 size-3" />
      Delete
    </Button>
  );
}

function CommentItem({ comment }: { comment: LessonCommentView }) {
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);

  return (
    <li>
      {comment.deleted || !comment.author ? (
        <p className="py-1 text-sm italic text-muted-foreground">[deleted]</p>
      ) : (
        <div className="flex gap-3">
          <UserAvatar
            name={comment.author.name}
            avatarUrl={comment.author.avatarUrl}
            className="shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{comment.author.name}</span>
              {comment.author.isInstructor && (
                <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
                  Instructor
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {formatCommentDate(comment.createdAt)}
                {comment.editedAt && " (edited)"}
              </span>
            </div>

            {editing ? (
              <CommentForm
                intent="update-comment"
                commentId={comment.id}
                initialContent={comment.content}
                submitLabel="Save"
                onDone={() => setEditing(false)}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                <CommentText content={comment.content} />
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {comment.canReply && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground"
                      onClick={() => setReplying((prev) => !prev)}
                    >
                      <Reply className="mr-1 size-3" />
                      Reply
                    </Button>
                  )}
                  {comment.canEdit && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground"
                      onClick={() => setEditing(true)}
                    >
                      <Pencil className="mr-1 size-3" />
                      Edit
                    </Button>
                  )}
                  {comment.canDelete && (
                    <DeleteCommentButton commentId={comment.id} />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {(comment.replies.length > 0 || replying) && (
        <div className="mt-3 ml-11 space-y-4 border-l pl-4">
          {comment.replies.length > 0 && (
            <ul className="space-y-4">
              {comment.replies.map((reply) => (
                <CommentItem key={reply.id} comment={reply} />
              ))}
            </ul>
          )}
          {replying && (
            <CommentForm
              intent="create-comment"
              parentId={comment.id}
              placeholder="Write a reply"
              submitLabel="Reply"
              onDone={() => setReplying(false)}
              onCancel={() => setReplying(false)}
            />
          )}
        </div>
      )}
    </li>
  );
}

export function LessonComments({
  comments,
  access,
}: {
  comments: LessonCommentView[];
  access: CommentAccess;
}) {
  return (
    <section className="mt-8 border-t pt-6">
      <h2 className="mb-4 text-xl font-semibold">Comments</h2>

      <div className="mb-6">
        {access.canWrite ? (
          <CommentForm
            intent="create-comment"
            placeholder="Ask a question or share a thought"
            submitLabel="Post comment"
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Comments are closed for this course.
          </p>
        )}
      </div>

      {comments.length === 0 ? (
        access.canWrite && (
          <p className="text-sm text-muted-foreground">
            No comments yet. Start the conversation.
          </p>
        )
      ) : (
        <ul className="space-y-6">
          {comments.map((comment) => (
            <CommentItem key={comment.id} comment={comment} />
          ))}
        </ul>
      )}
    </section>
  );
}
