//
// index.cpp
//
// This module build index on the multiresolution blocks for later
// fast retrieval of nonempty blocks
//
// Major assumption:
// 1) There are no more than 8 different block size.
//    This restriction can be relaxed by allocated more bits in "level_size"
//    to store block size info.
// 2) z value should be able to represent by [sizeof(short int)*8 - 3] bits
//
// Tien-Tsin Wong 1996
//
#include <stdlib.h>
#include <stdio.h>
#include "kdtree.h"
#include "misc.h"
#include "datatype.h"
#include "global.h"
#include "index.h"
#include "common.h"
#ifdef WIN32
#include "pcvalues.h"
#else
#include <values.h>
#endif

#define KEYNO           3   // total no of keys
#define KEYLEVELSIZE    0
#define KEYMAX          1
#define KEYMIN          2
#define LEVELNO         5   // no of hierarchical level of block support


///////////////////////// Global variables //////////////////////////
KdTree *kdtree;
DataBlock *array;
long elmno;  // size of array

//////////////////////// Function implementation ////////////////////
// can refer CurrKey to see which key to compare now
int compare(const void *key, const void *elm)
{
  DataBlock *k=&(array[*((long*)key)]), *e=&(array[*((long*)elm)]);
  switch (kdtree->CurrKey)
  {
    case KEYLEVELSIZE:  // compare key "level_size"
      if (k->level_size<e->level_size)
        return -1;
      else if (k->level_size==e->level_size)
        return 0;
      else
        return 1;
      break;
    case KEYMAX:  // compare the key "max"
      if (k->max<e->max)
        return -1;
      else if (k->max==e->max)
        return 0;
      else
        return 1;
      break;
    case KEYMIN:  // compare the key "min"
      if (k->min<e->min)
        return -1;
      else if (k->min==e->min)
        return 0;
      else
        return 1;
      break;
  }
  return 0;
}


// assume input an array of 2 data units
void initbound(void *in)
{
  DataBlock *arr=(DataBlock*)in;
  arr[KD_LOWERBND].level_size = 0;
  arr[KD_UPPERBND].level_size = MAXSHORT;
#ifdef DEBUG
  if (sizeof(VOXELDT)>1)
    ERREXIT ("[initbound]: upperbound of large data type not defined\n");
#endif
  arr[KD_LOWERBND].max = 0;  // lower bound
  arr[KD_UPPERBND].max = 255; // upper bound
  arr[KD_LOWERBND].min = 0;  // lower bound
  arr[KD_UPPERBND].min = 255; // upper bound
}


void limitbound(void *dest, const long &src, const int &key)
{
  DataBlock *d=(DataBlock*)dest, *s=&(array[src]);
  switch(key)
  {
    case KEYLEVELSIZE: d->level_size = s->level_size; break;
    case KEYMAX:       d->max = s->max; break;
    case KEYMIN:       d->min = s->min; break;
  }
}


int inregion(const long &p, void *rb)
{
  DataBlock *pt=&(array[p]);
  long level_size = ((DataBlock*)rb)->level_size;
  VOXELDT threshold = ((DataBlock*)rb)->max;

  if (pt->level_size == level_size
  &&  pt->max >= threshold && pt->min <= threshold)
    return TRUE;
  else
    return FALSE;
}


// if not intersect return 0
// if partially intersect return 1
// if bnd is inside requre bound return 2
int boundintersect(void *b, void *rb)
{
  DataBlock *bnd=(DataBlock*)b;
  long level_size = ((DataBlock*)rb)->level_size;
  VOXELDT threshold = ((DataBlock*)rb)->max;

  if (bnd[KD_LOWERBND].level_size == level_size  // level_size matched
  &&  bnd[KD_UPPERBND].level_size == level_size
  &&  bnd[KD_LOWERBND].max >= threshold && bnd[KD_UPPERBND].min <= threshold)
    return KD_INSIDE;
  if (bnd[KD_LOWERBND].level_size <= level_size
  &&  bnd[KD_UPPERBND].level_size >= level_size
  &&  bnd[KD_UPPERBND].max >= threshold && bnd[KD_LOWERBND].min <= threshold)
    return KD_PARTIALINTERSECT;
  return KD_NOTINTERSECT;
}


// Write indexed data to file
void writedatablock(FILE *fptr)
{
  if (cp_fwrite(&elmno, sizeof(long), 1, fptr)!=1)
    ERREXIT("[writedatablock]: Cannot write elmno to index file\n");
  if (cp_fwrite(array, sizeof(DataBlock), elmno, fptr)!=elmno)
    ERREXIT("[writedatablock]: Cannot write data block to index file\n");
}


// Read indexed data to file
void readdatablock(FILE *fptr)
{
  long readno;
  if (cp_fread(&elmno, sizeof(long), 1, fptr)!=1)
    ERREXIT("[readdatablock]: Cannot read elmno from index file\n");
  if ((array=(DataBlock*)malloc(sizeof(DataBlock)*elmno))==NULL)
    ERREXIT("[readdatablock]: no memory for data block\n");
  if ((readno=fread(array, sizeof(DataBlock), elmno, fptr))!=elmno)  // exempted from using cp_fread
    fprintf(stderr, "[readdatablock]: Cannot read data block from index file, read=%li, elmno=%li\n", readno, elmno);
#ifdef WIN32
  // Cross platform issue:
  for (int i=0 ; i<elmno ; i++)
    SingleSwapByte((unsigned char*)&(array[i].level_size), sizeof(short));
    // Swap max and min as well if VOXELDT is not single-byte.
#endif
}


// return the built kdtree to caller
// Note that the allocated array is not free. It is the
// responsibility of caller to delete it.
KdTree *KdIndexBlock(VOXELDT *data, int x, int y, int z, DataBlock *&allocarr)
{
  int i, j, k, wd, tmpmax[4], tmpmin[4], w, d, h, xy, a, b, l, ni, nj, nk;
  int i_1, j_1, k_1;
  long off1, off2, off3, lastoffstart, curroffstart, off;
  long *arrptr;

  w=x-1;  d=y-1;  h=z-1; // x y z represent the no of intervals now
  if (w>256 || d>256 || h>256) // To reduce memory usage, we use 1 byte to hold each dimension
    ERREXIT("[KdIndexBlock]: Please add precision to x, y, level_size of class DataBlock\n");

  for (i=0 ; i<LEVELNO ; i++)
  {
    elmno += w*d*h;   // Current version handle unit cube only, to be modified later
    w = (int)((float)w/2.0 + 0.5); // round to int
    d = (int)((float)d/2.0 + 0.5);
    h = (int)((float)h/2.0 + 0.5);
  }
  w=x-1;  d=y-1;  h=z-1; // x y z represent the no of intervals now

  if ((array=(DataBlock*)malloc(sizeof(DataBlock)*elmno))==NULL
  ||  (arrptr=(long*)malloc(sizeof(long)*elmno))==NULL)
    ERREXIT("[KdIndexBlock]: no enough memory\n");

  wd = w*d;
  xy = x*y;
  for (k=0, off1=0 ; k<h ; k++, off1+=wd)
    for (j=0, off2=off1 ; j<d ; j++, off2+=w)
      for (i=0, off3=off2 ; i<w ; i++, off3++)
      {
        if ((a=data[k*xy+j*x+i]) > (b=data[k*xy+j*x+(i+1)]))
          {tmpmax[0]=a; tmpmin[0]=b;} else {tmpmax[0]=b; tmpmin[0]=a;}
        if ((a=data[(k+1)*xy+j*x+i]) > (b=data[(k+1)*xy+j*x+(i+1)]))
          {tmpmax[1]=a; tmpmin[1]=b;} else {tmpmax[1]=b; tmpmin[1]=a;}
        if ((a=data[k*xy+(j+1)*x+i]) > (b=data[k*xy+(j+1)*x+(i+1)]))
          {tmpmax[2]=a; tmpmin[2]=b;} else {tmpmax[2]=b; tmpmin[2]=a;}
        if ((a=data[(k+1)*xy+(j+1)*x+i]) > (b=data[(k+1)*xy+(j+1)*x+(i+1)]))
          {tmpmax[3]=a; tmpmin[3]=b;} else {tmpmax[3]=b; tmpmin[3]=a;}
        tmpmax[0] = MAX(tmpmax[0], tmpmax[1]);
        tmpmax[1] = MAX(tmpmax[2], tmpmax[3]);
        tmpmin[0] = MIN(tmpmin[0], tmpmin[1]);
        tmpmin[1] = MIN(tmpmin[2], tmpmin[3]);
        array[off3].max = MAX(tmpmax[0],tmpmax[1]);
        array[off3].min = MIN(tmpmin[0],tmpmin[1]);
        array[off3].level_size = (k<<3)|0; // unit cube only currently for testing
        array[off3].x = i;
        array[off3].y = j;
        arrptr[off3] = off3;
      }

  lastoffstart = 0;
  off = curroffstart = off3;
  for (l=1 ; l<LEVELNO ; l++)  // index on hierarchical block also
  {
    for (k=0, nk=0 ; k<h ; k+=2, nk++)
    {
      k_1 = (k+1==h)? k : k+1;
      for (j=0, nj=0 ; j<d ; j+=2, nj++)
      {
        j_1 = (j+1==d)? j : j+1;
        for (i=0, ni=0 ; i<w ; i+=2, ni++)
        {
          i_1 = (i+1==w)? i : i+1;
          if ((a=array[lastoffstart+k*wd+j*w+i].max) > (b=array[lastoffstart+k*wd+j*w+i_1].max))
            tmpmax[0]=a; else tmpmax[0]=b;
          if ((a=array[lastoffstart+k_1*wd+j*w+i].max) > (b=array[lastoffstart+k_1*wd+j*w+i_1].max))
            tmpmax[1]=a; else tmpmax[1]=b;
          if ((a=array[lastoffstart+k*wd+j_1*w+i].max) > (b=array[lastoffstart+k*wd+j_1*w+i_1].max))
            tmpmax[2]=a; else tmpmax[2]=b;
          if ((a=array[lastoffstart+k_1*wd+j_1*w+i].max) > (b=array[lastoffstart+k_1*wd+j_1*w+i_1].max))
            tmpmax[3]=a; else tmpmax[3]=b;
          tmpmax[0] = MAX(tmpmax[0], tmpmax[1]);
          tmpmax[1] = MAX(tmpmax[2], tmpmax[3]);

          if ((a=array[lastoffstart+k*wd+j*w+i].min) < (b=array[lastoffstart+k*wd+j*w+i_1].min))
            tmpmin[0]=a; else tmpmin[0]=b;
          if ((a=array[lastoffstart+k_1*wd+j*w+i].min) < (b=array[lastoffstart+k_1*wd+j*w+i_1].min))
            tmpmin[1]=a; else tmpmin[1]=b;
          if ((a=array[lastoffstart+k*wd+j_1*w+i].min) < (b=array[lastoffstart+k*wd+j_1*w+i_1].min))
            tmpmin[2]=a; else tmpmin[2]=b;
          if ((a=array[lastoffstart+k_1*wd+j_1*w+i].min) < (b=array[lastoffstart+k_1*wd+j_1*w+i_1].min))
            tmpmin[3]=a; else tmpmin[3]=b;
          tmpmin[0] = MIN(tmpmin[0], tmpmin[1]);
          tmpmin[1] = MIN(tmpmin[2], tmpmin[3]);

          array[off].max = MAX(tmpmax[0], tmpmax[1]);
          array[off].min = MIN(tmpmin[0], tmpmin[1]);
          array[off].level_size = (nk<<3)|l;
          array[off].x = ni;
          array[off].y = nj;
          arrptr[off] = off;
          off++;
        }
      }
    }
    w = (int)((float)w/2.0 + 0.5); // round to int
    d = (int)((float)d/2.0 + 0.5); // next level of w, d and h
    h = (int)((float)h/2.0 + 0.5);
    wd = w*d;
    lastoffstart = curroffstart;
    curroffstart = off;
  }

//  for (i=0 ; i<elmno ; i++)
//    printf("[%2d] %li %d %d\n", i, array[i].level_size, array[i].min, array[i].max);

  kdtree = new KdTree(elmno, KEYNO, sizeof(DataBlock), compare, inregion, boundintersect,
                      initbound, limitbound, writedatablock, readdatablock);
  kdtree->BuildOptimalTree(1, arrptr, elmno, 0);
  allocarr = array;
  free(arrptr);
  return kdtree;
}


// Build the kdtree by read the index file instead
KdTree *ReadKdIndex(DCHAR *idxfile, int x, int y, int z, DataBlock *&allocarr)
{
  int i, w=x-1, d=y-1, h=z-1; // x y z represent the no of intervals now
  for (i=0 ; i<LEVELNO ; i++)
  {
    elmno += w*d*h;   // Current version handle unit cube only, to be modified later
    w = (int)((float)w/2.0 + 0.5); // round to int
    d = (int)((float)d/2.0 + 0.5);
    h = (int)((float)h/2.0 + 0.5);
  }
  kdtree = new KdTree(elmno, KEYNO, sizeof(DataBlock), compare, inregion, boundintersect,
                      initbound, limitbound, writedatablock, readdatablock);
  kdtree->ReadKdTree(idxfile);
  allocarr = array;
  return kdtree;
}



void QueryKdTree(KdTree *kdtree, int level, int nlevel, VOXELDT threshold, long *result, int maxcnt, int &resultcnt)
{
  DataBlock bnd[2];

  bnd[0].max = bnd[0].min = bnd[1].max = bnd[1].min = threshold;
  bnd[0].level_size = bnd[1].level_size = level<<3|(nlevel&0x07);
  kdtree->RegionSearch(result, maxcnt, resultcnt, bnd);

//  printf("\n\nSearch result:\n");
//  for (int i=0 ; i<resultcnt ; i++)
//    printf("[%2d] %li %d %d\n", i, result[i]->level_size, result[i]->min, result[i]->max);
//  printf("\n==========\n");
}


