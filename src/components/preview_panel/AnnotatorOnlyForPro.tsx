interface AnnotatorOnlyForProProps {
  onGoBack: () => void;
  children?: React.ReactNode;
}

export const AnnotatorOnlyForPro = ({ children }: AnnotatorOnlyForProProps) => {
  return <>{children}</>;
};
