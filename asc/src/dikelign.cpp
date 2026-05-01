//
// dikelign.cpp
//
// Define the class Lign and dike operations
//
// Tien-Tsin Wong 1996
//
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "asc.h"
#include "datatype.h"
#include "misc.h"
#include "common.h"
#include "dikelign.h"


//////////////////// Global variables visible to this module /////////////
// A few lookup tables to speed up
int G_LevelTable[DSIZE];
int G_LengthTable[DSIZE];
int G_NextDikeTable[DSIZE];
int G_StartTable[DSIZE];
int G_EndTable[DSIZE];
SIMPLEDT *Lign::nullsimple=NULL; // inited by LignNullSimpleInit(), once malloc, never free
int Lign::simplesize = 0;        // inited by LignNullSimpleInit()


///////////////////////// Routines for dike operations //////////////
// Notice that dike is not defined as a class for ease of use.

// Init the various dike lookup table
void DikeTableInit()
{
  for (int k=1 ; k<DSIZE ; k++)
  {
    //change from Log to Log10 by Kevin!!! (this causes bug in VC++6.0)
    G_LevelTable[k]    = (int)floor(log10((double)k)/log10((double)2)); 
    G_LengthTable[k]   = 1<<(NLEVEL-G_LevelTable[k]);
    G_NextDikeTable[k] = (k&(k+1))? k+1 : 0;
    G_StartTable[k]    = (k<<(NLEVEL-G_LevelTable[k]))-N;
    G_EndTable[k]      = G_StartTable[k] + G_LengthTable[k];
  }
}


// This function generates a list of dike which fill up the given
// range [minidx,maxidx]. minidx and maxidx's values are in the range
// [0, N]. It is the index at the bottom level with the leftmost one has
// index 0.
// "dike" is a user provided int array used to hold the generated dike number
// "dikecnt" is the total no of dike in the array. User should init it to 0
// if the array "dike" is empty
void MinDikeSet(int minidx, int maxidx, int *dike, int &dikecnt)
{
  int min, max, mask=1, currdike, t;
#ifdef SECURITY
  if (minidx<0 || minidx>N || maxidx<0 || maxidx>N || dike==NULL || dikecnt<0)
  {
    ERRMSG("[MinDikeSet]: invalid input\n");
    return;
  }
#endif
  min = MIN(minidx,maxidx);
  max = MAX(minidx,maxidx);
  min = min + N;
  max = max + N+1;

  while (min<max)
  {
    currdike = min;
    if (currdike&mask) // odd number
    {
      dike[dikecnt]=currdike;
      dikecnt++;
      min+=Length(currdike);
    }
    else // even number
    {
      t = Length(currdike);
      // grow the dike until overflow or dike is odd
      while (min+(t<<1)<=max && (currdike&mask)!=1)
      {
        t <<= 1;
        currdike >>= 1;
      }
      dike[dikecnt]=currdike;
      dikecnt++;
      min += t;
    }
  }
#ifdef DEBUG
  {
    for(int i=0; i<dikecnt ; i++)
      printf("%d ", dike[i]);
    printf("\n");
  }
#endif
}


// Break the dike into even smaller dikes if not all same-index-ydike are
// simple
void BreakDikeSet(int *ydike, int &ydikecnt, Lign *ylign, int i)
{
#ifdef SECURITY
  if (ydike==NULL || ydikecnt<0 || ylign==NULL || i<1 || i>=SIZE)
  {
    ERRMSG("[BreakDikeSet]: invalid input value\n");
    return;
  }
#endif
  register int jj, ii;
  for (jj=0 ; jj<ydikecnt ; jj++)
    do
    {
      for (ii=Start(i) ; ii<=End(i) ; ii++)
        if (ylign[ii].occ[ydike[jj]]==COMPLEX)
        {
          ydike[jj] <<= 1;       // let this be its left child
          ydike[ydikecnt] = ydike[jj]+1;  // append right child at the end
          ydikecnt++;
          break;
        }
    }while (ii<=End(i));  // all simple
}


///////////////////////////// Class lign /////////////////////////////////
// Make sure to call this routine at the beginning of the main()
void LignNullSimpleInit()
{
  int i;
  Lign::simplesize = sizeof(SIMPLEDT)*SIZE;
  if ((Lign::nullsimple=(SIMPLEDT*)malloc(Lign::simplesize))==NULL)
    ERREXIT("[LignNullSimpleInit]: Cannot alloc mem for nullsimple\n");
  for (i=0 ; i<SIZE ; i++)
    Lign::nullsimple[i] = (SIMPLEDT)-1;
}


void Lign::Init(CHAR *inocc, SIMPLEDT *inver)
{
#ifdef SECURITY
  if (inocc==NULL || inver==NULL)
    ERREXIT("[Lign::Init]: invalid input value\n");
#endif
  occ = inocc;
  ver = inver;
  InitSimple();
}


void Lign::InitSimple()
{
  memcpy(simple, nullsimple, simplesize);
  SimpleQ(1, -1);
#ifdef DEBUG
  DISPLAYTREE(simple);
#endif
}


// inherent hold the id of the topmost simple dike
// It contains -1 if the previous top dike are not simple
// it also hold the info propogated downward the binary tree
int Lign::SimpleQ(int myid, int inherent)
{
  if (myid>=SIZE)
    return myid>>1;  // return the bottom leaf's id

  if (inherent>0)  // parent is simple
  {
    if (0x01 & myid) // I am right child, I must be simple
      simple[myid] = myid;
    else // I am left child, then inherent the simplicity
      simple[myid] = inherent;
    // propogate info downward
    SimpleQ(myid<<1, simple[myid]);   // visit left child
    SimpleQ((myid<<1)+1, simple[myid]); // visit right child
  }
  else // parent is not simple
  {
    if (occ[myid]<COMPLEX) // but I am simple
    {
      simple[myid] = myid;
      // propogate info downward
      SimpleQ(myid<<1, simple[myid]);   // visit left child
      SimpleQ((myid<<1)+1, simple[myid]); // visit right child
    }
    else // I am not simple also, ask my descendant for simple
    {
      int descendant;
      descendant = SimpleQ(myid<<1, simple[myid]);     // visit left child
      SimpleQ((myid<<1)+1, simple[myid]);                // visit right child
      simple[myid] = descendant;
    }
  }

#ifdef DEBUG
  DISPLAYTREE(simple);
#endif

  // propogate info upward
  return simple[myid];
}


// Propagate info in the simple array upward
void Lign::PropagateUpSimple()
{
  register int i;
  for (i=N-1 ; i>0 ; i--)
    simple[i] = simple[i<<1];
  simple[0] = (SIMPLEDT)-1; // undefined
}


// Propagate info in the simple array downward
void Lign::PropagateDownSimple()
{
  register int i;
  for (i=1 ; i<SIZE ; i++)
    if (simple[i] == (SIMPLEDT)-1) // no value filled
      if (0x01&i)  // odd
        simple[i] = i;
      else  // even inherent from parent
        simple[i] = simple[i>>1];
}


void Lign::MaxSimple(Lign *neighbor)
{
#ifdef SECURITY
  if (neighbor==NULL)
  {
    ERRMSG("[Lign::MaxSimple]: invalid input value\n");
    return;
  }
#endif
  register int i;
  SIMPLEDT *simp, *neigh;
  simp  = &(simple[1]);
  neigh = &(neighbor->simple[1]);
  for (i=1 ; i<SIZE ; i++, simp++, neigh++)
    *simp = MAX(*simp, *neigh);
}



// fill up the vancany in the bottommost level of the simple[] with
// the max sized dike
void Lign::FillSimpleVacancy()
{
   int dikearr[N], dikecnt, i, empbegin, l;
   for (i=0, empbegin=0 ; i<N ; i++)
     if (simple[i+N]!=(SIMPLEDT)-1)
     {
       if (empbegin<i)
       {
         dikecnt = 0;
         MinDikeSet(empbegin, i-1, dikearr, dikecnt);
         for (l=0 ; l<dikecnt ; l++)
           simple[Start(dikearr[l])+N] = dikearr[l];
         empbegin = i;
       }
       empbegin++;
     }
   if (empbegin<i)
   {
     dikecnt = 0;
     MinDikeSet(empbegin, i-1, dikearr, dikecnt);
     for (l=0 ; l<dikecnt ; l++)
       simple[Start(dikearr[l])+N] = dikearr[l];
   }
}



void Lign::FillSpecSimpleVacancy()
{
   int i, empbegin, l;
   for (i=0, empbegin=0 ; i<N ; i++)
     if (simple[i]!=(SIMPLEDT)-1)
     {
       if (empbegin<i)
       {
         for (l=empbegin ; l<i ; l++)
           simple[l] = N-(i-l);
         empbegin = i;
       }
       empbegin++;
     }
   if (empbegin<i)
     for (l=empbegin ; l<i ; l++)
       simple[l] = N-(i-l);
}

