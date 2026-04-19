export interface GridImage {
  id: string
  signed_url: string
  label: string
  finish?: string | null
}

export function ImageGrid({
  images,
  versionNumber,
  onImageClick,
}: {
  images: GridImage[]
  versionNumber: number
  onImageClick: (src: string) => void
}) {
  if (images.length === 0) {
    return (
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
        <div className="flex h-64 items-center justify-center text-gray-400">
          Image unavailable
        </div>
      </div>
    )
  }

  if (images.length === 1) {
    return (
      <div
        className="cursor-zoom-in overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200"
        onClick={() => onImageClick(images[0].signed_url)}
      >
        <img
          src={images[0].signed_url}
          alt={`Proof version ${versionNumber}`}
          className="w-full object-contain"
        />
        {images[0].label && (
          <div className="border-t border-gray-100 px-4 py-2 text-center text-sm text-gray-500">
            {images[0].label}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {images.map((img) => (
        <div
          key={img.id}
          className="cursor-zoom-in overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-200"
          onClick={() => onImageClick(img.signed_url)}
        >
          <img
            src={img.signed_url}
            alt={img.label || `Proof version ${versionNumber}`}
            className="w-full object-contain"
          />
          {img.label && (
            <div className="border-t border-gray-100 px-4 py-2 text-center text-sm text-gray-500">
              {img.label}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
