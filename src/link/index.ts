import fs = require('mz/fs')
import path = require('path')
import linkDir from 'link-dir'
import symlinkDir from 'symlink-dir'
import exists = require('path-exists')
import logger from 'pnpm-logger'
import R = require('ramda')
import globalBinPath = require('global-bin-path')
import pLimit = require('p-limit')
import {InstalledPackage} from '../install/installMultiple'
import {InstalledPackages} from '../api/install'
import linkBins from './linkBins'
import {Package} from '../types'
import resolvePeers, {ResolvedDependencyTree, ResolvedDependencyTreeMap} from './resolvePeers'

export type LinkedPackage = {
  id: string,
  pkg: Package,
  localLocation: string,
  path: string,
  fetchingFiles: Promise<boolean>,
  dependencies: string[],
}

export type LinkedPackagesMap = {
  [id: string]: LinkedPackage
}

export default async function (
  topPkgs: InstalledPackage[],
  installedPkgs: InstalledPackages,
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
  }
): Promise<ResolvedDependencyTreeMap> {
  const pkgsToLink = await resolvePeers(R.values(installedPkgs)
    .reduce((pkgsToLink, installedPkg) => {
      pkgsToLink[installedPkg.id] = {
        id: installedPkg.id,
        pkg: installedPkg.pkg,
        fetchingFiles: installedPkg.fetchingFiles,
        localLocation: path.join(opts.baseNodeModules, `.${installedPkg.id}`),
        path: installedPkg.path,
        dependencies: installedPkg.dependencies,
      }
      return pkgsToLink
    }, {}), topPkgs.filter(pkg => pkg.isInstallable).map(pkg => pkg.id))

  const flatResolvedDeps =  R.values(pkgsToLink).sort((a, b) => a.depth - b.depth)

  const deps = <ResolvedDependencyTree[]>R.uniqBy(R.prop('hardlinkedLocation'), flatResolvedDeps)

  await linkAllPkgs(deps, opts)

  const depsByModules = <ResolvedDependencyTree[]>R.uniqBy(R.prop('modules'), flatResolvedDeps)

  await linkAllIndependentModules(depsByModules, pkgsToLink)

  await linkAllModules(deps, pkgsToLink)

  for (let pkg of flatResolvedDeps.filter(pkg => pkg.depth === 0)) {
    await symlinkDependencyTo(pkg, opts.baseNodeModules)
  }
  const binPath = opts.global ? globalBinPath() : path.join(opts.baseNodeModules, '.bin')
  await linkBins(opts.baseNodeModules, binPath)

  return pkgsToLink
}

const limitLinking = pLimit(16)

async function linkAllPkgs (
  alldeps: ResolvedDependencyTree[],
  opts: {
    force: boolean,
    global: boolean,
    baseNodeModules: string,
  }
) {
  return Promise.all(
    alldeps.map(pkg => limitLinking(() => linkPkg(pkg, opts)))
  )
}

async function linkAllModules (
  pkgs: ResolvedDependencyTree[],
  pkgMap: ResolvedDependencyTreeMap
) {
  return Promise.all(
    pkgs.map(pkg => limitLinking(() => linkModules(pkg, pkgMap)))
  )
}

async function linkAllIndependentModules (
  pkgs: ResolvedDependencyTree[],
  pkgMap: ResolvedDependencyTreeMap
) {
  return Promise.all(
    pkgs.map(pkg => limitLinking(() => linkIndependentModules(pkg, pkgMap)))
  )
}

async function linkPkg (
  dependency: ResolvedDependencyTree,
  opts: {
    force: boolean,
    baseNodeModules: string,
  }
) {
  const newlyFetched = await dependency.fetchingFiles

  const pkgJsonPath = path.join(dependency.hardlinkedLocation, 'package.json')
  if (newlyFetched || opts.force || !await exists(pkgJsonPath) || !await pkgLinkedToStore(pkgJsonPath, dependency)) {
    await linkDir(dependency.path, dependency.hardlinkedLocation)
  }
}

async function pkgLinkedToStore (pkgJsonPath: string, dependency: ResolvedDependencyTree) {
  const pkgJsonPathInStore = path.join(dependency.path, 'package.json')
  if (await isSameFile(pkgJsonPath, pkgJsonPathInStore)) return true
  logger.info(`Relinking ${dependency.hardlinkedLocation} from the store`)
  return false
}

async function isSameFile (file1: string, file2: string) {
  const stats = await Promise.all([fs.stat(file1), fs.stat(file2)])
  return stats[0].ino === stats[1].ino
}

async function linkIndependentModules (pkg: ResolvedDependencyTree, pkgMap: ResolvedDependencyTreeMap) {
  await Promise.all(
    R.props<ResolvedDependencyTree>(pkg.children, pkgMap)
      .map(child => symlinkDependencyTo(child, pkg.modules))
  )
}

async function linkModules (
  dependency: ResolvedDependencyTree,
  pkgMap: ResolvedDependencyTreeMap
) {
  await Promise.all(
    R.props<ResolvedDependencyTree>(dependency.resolvedPeers, pkgMap)
      .map(peer => symlinkDependencyTo(peer, <string>dependency.peerModules))
  )

  const binPath = path.join(dependency.hardlinkedLocation, 'node_modules', '.bin')
  await linkBins(dependency.modules, binPath, dependency.name)
  if (dependency.peerModules) {
    await linkBins(dependency.peerModules, binPath, dependency.name)
  }

  // link also the bundled dependencies` bins
  if (dependency.hasBundledDependencies) {
    const bundledModules = path.join(dependency.hardlinkedLocation, 'node_modules')
    await linkBins(bundledModules, binPath)
  }
}

function symlinkDependencyTo (dependency: ResolvedDependencyTree, dest: string) {
  dest = path.join(dest, dependency.name)
  return symlinkDir(dependency.hardlinkedLocation, dest)
}