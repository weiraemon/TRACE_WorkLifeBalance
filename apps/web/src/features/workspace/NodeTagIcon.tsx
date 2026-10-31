import {
  ChatBubbleIcon,
  TargetIcon,
  FileTextIcon,
  CheckCircledIcon,
  BookmarkIcon,
  MixerHorizontalIcon,
} from '@radix-ui/react-icons';
const tagIcons: Record<string, typeof ChatBubbleIcon> = {
  会议: ChatBubbleIcon,
  报告: FileTextIcon,
  专注: TargetIcon,
  实验: MixerHorizontalIcon,
  讨论: ChatBubbleIcon,
  审阅: CheckCircledIcon,
};
export function NodeTagIcon({ tag }: { tag: string }) {
  const Icon = tagIcons[tag] ?? BookmarkIcon;
  return <Icon aria-hidden="true" />;
}
