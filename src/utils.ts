const annotationPrefix: string = 'ksnapshot.clickandmortar.fr'

export const getAnnotation = (key: string): string => {
    return `${annotationPrefix}/${key}`
}
