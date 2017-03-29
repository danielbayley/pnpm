import {LinkedPackagesMap, LinkedPackage} from '.'
import {Dependencies, Package} from '../types'
import R = require('ramda')
import semver = require('semver')
import logger from 'pnpm-logger'
import path = require('path')

export type DependencyTree = {
  id: string,
  name: string,
  version: string,
  peerDependencies: Dependencies,
  hasBundledDependencies: boolean,
  fetchingFiles: Promise<boolean>,
  localLocation: string,
  path: string,
  keypathId: string,
  children: string[],
  depth: number,
}

export type ResolvedDependencyTree = {
  name: string,
  hasBundledDependencies: boolean,
  path: string,
  modules: string,
  peerModules?: string,
  fetchingFiles: Promise<boolean>,
  hardlinkedLocation: string,
  children: string[],
  resolvedPeers: string[],
  depth: number,
  id: string,
}

export type ResolvedDependencyTreeMap = {
  [keypathId: string]: ResolvedDependencyTree
}

export default function (pkgsMap: LinkedPackagesMap, topPkgIds: string[]): ResolvedDependencyTreeMap {
  const treeMap = {}
  const rootNodeIds = createTree(pkgsMap, topPkgIds, [], treeMap)

  const pkgsByName = toPkgByName(R.props<DependencyTree>(rootNodeIds, treeMap))
  const resolvedTreeMap = R.reduce(R.merge, {}, rootNodeIds.map(rootNodeId => resolvePeersOfNode(rootNodeId, pkgsByName, treeMap)))
  return resolvedTreeMap
}

function createTree (pkgsMap: LinkedPackagesMap, pkgIds: string[], keypath: string[], treeMap: {[keypathId: string]: DependencyTree}): string[] {
  return R.props(pkgIds, pkgsMap)
    .map((pkg: LinkedPackage) => {
      const nonCircularDeps = getNonCircularDependencies(pkg.id, pkg.dependencies, keypath)
      const newKeypath = R.append(pkg.id, keypath)
      const keypathId = newKeypath.join('/')
      treeMap[keypathId] = {
        id: pkg.id,
        name: pkg.pkg.name,
        version: pkg.pkg.version,
        peerDependencies: pkg.pkg.peerDependencies || {},
        hasBundledDependencies: !!(pkg.pkg.bundledDependencies || pkg.pkg.bundleDependencies),
        fetchingFiles: pkg.fetchingFiles,
        localLocation: pkg.localLocation,
        path: pkg.path,
        keypathId,
        children: createTree(pkgsMap, nonCircularDeps, newKeypath, treeMap),
        depth: keypath.length,
      }
      return keypathId
    })
}

function getNonCircularDependencies (
  parentId: string,
  dependencyIds: string[],
  keypath: string[]
) {
  const relations = R.aperture(2, keypath)
  const isCircular = R.partialRight(R.contains, [relations])
  return dependencyIds.filter(depId => !isCircular([parentId, depId]))
}

function resolvePeersOfNode (
  keypathId: string,
  parentPkgs: {[name: string]: DependencyTree},
  treeMap: {[keypathId: string]: DependencyTree}
): ResolvedDependencyTreeMap {
  const pkgNode = treeMap[keypathId]
  const newParentPkgs = Object.assign({}, parentPkgs,
    {[pkgNode.name]: pkgNode},
    toPkgByName(R.props<DependencyTree>(pkgNode.children, treeMap))
  )

  const resolvedPeers = resolvePeers(pkgNode.peerDependencies, pkgNode.id, newParentPkgs)

  const modules = path.join(pkgNode.localLocation, 'node_modules')
  const peerModules = !R.isEmpty(pkgNode.peerDependencies)
    ? path.join(pkgNode.localLocation, createPeersFolderName(R.props<DependencyTree>(resolvedPeers, treeMap)), 'node_modules')
    : undefined

  const hardlinkedLocation = path.join(peerModules || modules, pkgNode.name)

  return R.reduce(R.merge, R.objOf(keypathId, {
    name: pkgNode.name,
    hasBundledDependencies: pkgNode.hasBundledDependencies,
    fetchingFiles: pkgNode.fetchingFiles,
    path: pkgNode.path,
    peerModules,
    modules,
    hardlinkedLocation,
    resolvedPeers,
    children: pkgNode.children,
    depth: pkgNode.depth,
    id: pkgNode.id,
  }), pkgNode.children.map(child => resolvePeersOfNode(child, newParentPkgs, treeMap)))
}

function resolvePeers (
  peerDependencies: Dependencies,
  pkgId: string,
  parentPkgs: {[name: string]: DependencyTree},
): string[] {
  return R.toPairs(peerDependencies)
    .map(R.apply((peerName: string, peerVersionRange: string) => {
      const resolved = parentPkgs[peerName]

      if (!resolved) {
        logger.warn(`${pkgId} requires a peer of ${peerName}@${peerVersionRange} but none was installed.`)
        return null
      }

      if (!semver.satisfies(resolved.version, peerVersionRange)) {
        logger.warn(`${pkgId} requires a peer of ${peerName}@${peerVersionRange} but version ${resolved.version} was installed.`)
      }

      return resolved && resolved.keypathId
    }))
    .filter(Boolean) as string[]
}

function toPkgByName(pkgs: DependencyTree[]): {[pkgName: string]: DependencyTree} {
  const toNameAndPkg = R.map((pkg: DependencyTree): R.KeyValuePair<string, DependencyTree> => [pkg.name, pkg])
  return R.fromPairs(toNameAndPkg(pkgs))
}

function createPeersFolderName(peers: DependencyTree[]) {
  return peers.map(peer => `${peer.name.replace('/', '!')}@${peer.version}`).sort().join('+')
}
